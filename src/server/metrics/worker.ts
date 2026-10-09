import { prepareRollupChanges, publishRollups } from './rollups';
import type pg from 'pg';
import { transaction } from '@/server/db/metrics';
// Row locks last through publication; rollback releases work without a stale lease owner.
export async function processMetricBatch(pool:pg.Pool,batchSize=1000,failBeforeCommit=false){return transaction(pool,async c=>{
 const source=(await c.query('SELECT s.id FROM metric_sources s WHERE EXISTS(SELECT 1 FROM metric_record_keys r WHERE r.source_id=s.id AND NOT r.processed) ORDER BY s.last_processed_at NULLS FIRST,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED')).rows[0];if(!source)return 0;
 await c.query('UPDATE metric_sources SET last_processed_at=clock_timestamp() WHERE id=$1',[source.id]);
 await c.query('CREATE TEMP TABLE metric_batch ON COMMIT DROP AS SELECT * FROM metric_record_keys WHERE NOT processed AND source_id=$2 ORDER BY received_at,record_id LIMIT $1 FOR UPDATE SKIP LOCKED',[batchSize,source.id]);
 await c.query('CREATE INDEX ON metric_batch(source_id,record_id); ANALYZE metric_batch');
 const count=Number((await c.query('SELECT count(*) FROM metric_batch')).rows[0].count);if(!count)return 0;
 // Order metric locks globally to serialize corrections/publication for a metric and avoid deadlocks.
 const keys=await c.query(`SELECT DISTINCT p->>'metricId' id FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p UNION SELECT DISTINCT f.metric_id::text id FROM metric_facts f JOIN metric_batch b ON f.source_id=b.source_id AND f.record_id=b.record_id WHERE b.revision>1 ORDER BY id`);
 for(const {id}of keys.rows)await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric:${id}`]);
 const hasCorrections=Number((await c.query('SELECT count(*) n FROM metric_batch WHERE revision>1')).rows[0].n)>0;
 // Load the exact versions once per batch. Policy metrics never write legacy hourly states.
 await c.query(`CREATE TEMP TABLE metric_batch_definitions ON COMMIT DROP AS
 SELECT v.metric_id,v.version,v.config,coalesce(v.config->'storagePolicy'<>'null'::jsonb,false) policy
 FROM metric_definition_versions v JOIN (
  SELECT DISTINCT (p->>'metricId')::uuid metric_id,(p->>'version')::int version
  FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p
  UNION SELECT DISTINCT f.metric_id,f.version FROM metric_facts f JOIN metric_batch b USING(source_id,record_id) WHERE b.revision>1
 ) k USING(metric_id,version);
 CREATE UNIQUE INDEX ON metric_batch_definitions(metric_id,version); ANALYZE metric_batch_definitions;`);
 if(hasCorrections)await prepareRollupChanges(c);
 if(!hasCorrections){
 await c.query(`CREATE TEMP TABLE metric_new ON COMMIT DROP AS
 SELECT b.source_id,b.record_id,b.revision,(p->>'metricId')::uuid metric_id,(p->>'version')::int version,(p->>'observedAt')::timestamptz observed_at,(p->>'endsAt')::timestamptz ends_at,p->'dimensions' dimensions,(p->>'v')::numeric v,(p->>'n')::numeric n,(p->>'d')::numeric d,(p->>'weight')::numeric weight,p->>'identity' identity,b.received_at
 FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p
 WHERE NOT EXISTS(SELECT 1 FROM metric_record_keys newer WHERE newer.source_id=b.source_id AND newer.record_id=b.record_id AND newer.revision>b.revision);
 INSERT INTO metric_facts SELECT * FROM metric_new;
 INSERT INTO metric_aggregate_states(metric_id,version,bucket,dimensions,total,weight,n,d,min,max,last,last_at,count,generation)
 SELECT metric_id,version,date_trunc('hour',observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',dimensions,COALESCE(sum(v),0),sum(weight),sum(n),sum(d),min(v),max(v),(array_agg(v ORDER BY observed_at DESC,record_id DESC))[1],max(observed_at),count(*),txid_current() FROM metric_new f JOIN metric_batch_definitions m USING(metric_id,version) WHERE ends_at IS NULL AND NOT m.policy GROUP BY metric_id,version,date_trunc('hour',observed_at AT TIME ZONE 'UTC'),dimensions
 ON CONFLICT(metric_id,version,bucket,dimensions) DO UPDATE SET total=metric_aggregate_states.total+EXCLUDED.total,weight=metric_aggregate_states.weight+EXCLUDED.weight,n=metric_aggregate_states.n+EXCLUDED.n,d=metric_aggregate_states.d+EXCLUDED.d,min=least(metric_aggregate_states.min,EXCLUDED.min),max=greatest(metric_aggregate_states.max,EXCLUDED.max),last=CASE WHEN EXCLUDED.last_at>=metric_aggregate_states.last_at THEN EXCLUDED.last ELSE metric_aggregate_states.last END,last_at=greatest(metric_aggregate_states.last_at,EXCLUDED.last_at),count=metric_aggregate_states.count+EXCLUDED.count,generation=EXCLUDED.generation;
 UPDATE metric_record_keys r SET processed=true FROM metric_batch b WHERE r.source_id=b.source_id AND r.record_id=b.record_id AND r.revision=b.revision;
 UPDATE metric_ingestions i SET status='completed',completed_at=now() WHERE i.id IN(SELECT ingestion_id FROM metric_batch) AND NOT EXISTS(SELECT 1 FROM metric_record_keys r WHERE r.ingestion_id=i.id AND NOT r.processed);`);
 await publishRollups(c,true);
 if(failBeforeCommit)throw new Error('Injected failure before publication');return count;
 }
 await c.query(`CREATE TEMP TABLE metric_dirty ON COMMIT DROP AS SELECT DISTINCT f.metric_id,f.version,date_trunc('hour',f.observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' bucket,f.dimensions FROM metric_facts f JOIN metric_batch b ON f.source_id=b.source_id AND f.record_id=b.record_id JOIN metric_batch_definitions m ON m.metric_id=f.metric_id AND m.version=f.version WHERE NOT m.policy`);
 await c.query(`DELETE FROM metric_facts f USING metric_batch b WHERE f.source_id=b.source_id AND f.record_id=b.record_id AND f.revision<=b.revision`);
 await c.query(`INSERT INTO metric_facts(source_id,record_id,revision,metric_id,version,observed_at,ends_at,dimensions,v,n,d,weight,identity,received_at)
 SELECT b.source_id,b.record_id,b.revision,(p->>'metricId')::uuid,(p->>'version')::int,(p->>'observedAt')::timestamptz,(p->>'endsAt')::timestamptz,p->'dimensions',(p->>'v')::numeric,(p->>'n')::numeric,(p->>'d')::numeric,(p->>'weight')::numeric,p->>'identity',b.received_at
 FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p
 WHERE NOT EXISTS(SELECT 1 FROM metric_record_keys newer WHERE newer.source_id=b.source_id AND newer.record_id=b.record_id AND newer.revision>b.revision)
 ON CONFLICT DO NOTHING`);
 await c.query(`INSERT INTO metric_dirty SELECT DISTINCT (p->>'metricId')::uuid,(p->>'version')::int,date_trunc('hour',(p->>'observedAt')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',p->'dimensions' FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p JOIN metric_batch_definitions m ON m.metric_id=(p->>'metricId')::uuid AND m.version=(p->>'version')::int WHERE NOT m.policy`);
 await c.query('CREATE INDEX ON metric_dirty(metric_id,version,bucket); ANALYZE metric_dirty');
 // States only contain point facts. Interval aggregates are queried without pretending they can be split.
 await c.query(`DELETE FROM metric_aggregate_states a USING metric_dirty d WHERE a.metric_id=d.metric_id AND a.version=d.version AND a.bucket=d.bucket AND a.dimensions=d.dimensions`);
 await c.query(`INSERT INTO metric_aggregate_states(metric_id,version,bucket,dimensions,total,weight,n,d,min,max,last,last_at,count,generation)
 SELECT f.metric_id,f.version,date_trunc('hour',f.observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',f.dimensions,COALESCE(sum(v),0),sum(weight),sum(n),sum(d),min(v),max(v),(array_agg(v ORDER BY observed_at DESC,record_id DESC))[1],max(observed_at),count(*),txid_current()
 FROM metric_facts f JOIN (SELECT DISTINCT * FROM metric_dirty) k ON f.metric_id=k.metric_id AND f.version=k.version AND f.dimensions=k.dimensions AND f.observed_at>=k.bucket AND f.observed_at<k.bucket+interval '1 hour'
 WHERE f.ends_at IS NULL GROUP BY f.metric_id,f.version,date_trunc('hour',f.observed_at AT TIME ZONE 'UTC'),f.dimensions`);
 await c.query('UPDATE metric_record_keys r SET processed=true FROM metric_batch b WHERE r.source_id=b.source_id AND r.record_id=b.record_id AND r.revision=b.revision');
 await c.query(`UPDATE metric_ingestions i SET status='completed',completed_at=now() WHERE i.id IN(SELECT ingestion_id FROM metric_batch) AND NOT EXISTS(SELECT 1 FROM metric_record_keys r WHERE r.ingestion_id=i.id AND NOT r.processed)`);
 await publishRollups(c);
 if(failBeforeCommit)throw new Error('Injected failure before publication');return count;});}
