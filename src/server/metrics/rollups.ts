import type pg from 'pg';
import type { MetricDefinition } from '@/models/metrics/types';
import { getMetric } from './service';
import { bucketSql,endSql,levels } from './resolution-sql';
import { transaction } from '@/server/db/metrics';
// The caller holds the same source/metric locks as fact publication.
export async function prepareRollupChanges(c:pg.PoolClient){
 await c.query(`CREATE TEMP TABLE metric_resolution_dirty ON COMMIT DROP AS
 SELECT (p->>'metricId')::uuid metric_id,(p->>'version')::int version,(p->>'observedAt')::timestamptz observed_at,p->'dimensions' dimensions FROM metric_batch b CROSS JOIN LATERAL jsonb_array_elements(b.payload->'projections') p
 UNION SELECT f.metric_id,f.version,f.observed_at,f.dimensions FROM metric_facts f JOIN metric_batch b USING(source_id,record_id);
 CREATE INDEX ON metric_resolution_dirty(metric_id,version,observed_at); ANALYZE metric_resolution_dirty;`);
}
export async function publishRollups(c:pg.PoolClient,incremental=false){
 const metrics=await c.query<{metric_id:string;version:number;config:MetricDefinition}>('SELECT metric_id,version,config FROM metric_batch_definitions WHERE policy ORDER BY metric_id,version');
 for(const r of metrics.rows){const m={...r.config,id:r.metric_id,version:r.version};if(!m.storagePolicy)continue;
  if(incremental){await appendRollups(c,m);continue;}
  const base=m.storagePolicy.baseResolution;
  for(const level of levels(base)){
   const b=bucketSql('observed_at',level,'$4');
   await c.query(`CREATE TEMP TABLE metric_rollup_dirty ON COMMIT DROP AS SELECT DISTINCT ${b} bucket,dimensions FROM metric_resolution_dirty WHERE metric_id=$1 AND version=$2 AND $3::text IS NOT NULL AND $4::text IS NOT NULL`,[m.id,m.version,level,m.timezone]);
   await c.query('CREATE INDEX ON metric_rollup_dirty(bucket,dimensions); ANALYZE metric_rollup_dirty');
   await c.query('DELETE FROM metric_rollups a USING metric_rollup_dirty d WHERE a.metric_id=$1 AND a.version=$2 AND a.level=$3 AND a.bucket=d.bucket AND a.dimensions=d.dimensions',[m.id,m.version,level]);
   const finish=endSql('k.bucket',level,'$4');
   // Retained raw detail is authoritative for corrections. Finer states may already
   // have expired even when raw retention is unlimited; rebuilding a parent from
   // only the remaining children would silently discard its older contributions.
   {
    await c.query(`INSERT INTO metric_rollups
     SELECT $1,$2,$3,k.bucket,${finish},f.dimensions,coalesce(sum(v),0),sum(n),sum(d),min(v),max(v),
     (array_agg(v ORDER BY observed_at DESC,source_id DESC,record_id DESC))[1],max(observed_at),
     (array_agg(source_id::text||':'||record_id ORDER BY observed_at DESC,source_id DESC,record_id DESC))[1],count(*),max(received_at)
     FROM metric_facts f JOIN metric_rollup_dirty k ON f.dimensions=k.dimensions AND f.observed_at>=k.bucket AND f.observed_at<${finish}
     WHERE f.metric_id=$1 AND f.version=$2 AND $4::text IS NOT NULL GROUP BY k.bucket,f.dimensions`,[m.id,m.version,level,m.timezone]);
   }
   await c.query('DROP TABLE metric_rollup_dirty');
  }
 }
}

// Contributions contain only newly published records, never accumulated bucket totals.
// Merge the same sufficient statistics as a rebuild; corrections still take that bounded path.
async function appendRollups(c:pg.PoolClient,m:MetricDefinition & {id:string;version:number}){
 const base=m.storagePolicy!.baseResolution;
 const bucket=bucketSql('f.observed_at',base,'$3');
 const finish=endSql(bucket,base,'$3');
 await c.query(`CREATE TEMP TABLE metric_rollup_delta ON COMMIT DROP AS
  SELECT ${bucket} bucket,${finish} ends_at,f.dimensions,coalesce(sum(v),0) total,sum(n) n,sum(d) d,min(v) min,max(v) max,
   (array_agg(v ORDER BY observed_at DESC,source_id DESC,record_id DESC))[1] last,max(observed_at) last_at,
   (array_agg(source_id::text||':'||record_id ORDER BY observed_at DESC,source_id DESC,record_id DESC))[1] last_key,
   count(*) count,max(received_at) received_at
  FROM metric_new f WHERE f.metric_id=$1 AND f.version=$2 AND $3::text IS NOT NULL
  GROUP BY ${bucket},f.dimensions`,[m.id,m.version,m.timezone]);
 const newer='(EXCLUDED.last_at,EXCLUDED.last_key)>(current.last_at,current.last_key)';
 const merge=`ON CONFLICT(metric_id,version,level,bucket,dimensions) DO UPDATE SET
  total=current.total+EXCLUDED.total,n=current.n+EXCLUDED.n,d=current.d+EXCLUDED.d,
  min=least(current.min,EXCLUDED.min),max=greatest(current.max,EXCLUDED.max),
  last=CASE WHEN ${newer} THEN EXCLUDED.last ELSE current.last END,
  last_at=greatest(current.last_at,EXCLUDED.last_at),
  last_key=CASE WHEN ${newer} THEN EXCLUDED.last_key ELSE current.last_key END,
  count=current.count+EXCLUDED.count,received_at=greatest(current.received_at,EXCLUDED.received_at)`;
 for(const level of levels(base)){
  const b=bucketSql('bucket',level,'$4');
  const select=level===base
   ?`SELECT $1,$2,$3,bucket,ends_at,dimensions,total,n,d,min,max,last,last_at,last_key,count,received_at
     FROM metric_rollup_delta WHERE $4::text IS NOT NULL`
   :`SELECT $1,$2,$3,${b},${endSql(b,level,'$4')},dimensions,sum(total),sum(n),sum(d),min(min),max(max),
     (array_agg(last ORDER BY last_at DESC,last_key DESC))[1],max(last_at),
     (array_agg(last_key ORDER BY last_at DESC,last_key DESC))[1],sum(count),max(received_at)
     FROM metric_rollup_delta WHERE $4::text IS NOT NULL GROUP BY ${b},dimensions`;
  await c.query(`INSERT INTO metric_rollups AS current
   (metric_id,version,level,bucket,ends_at,dimensions,total,n,d,min,max,last,last_at,last_key,count,received_at)
   ${select} ${merge}`,[m.id,m.version,level,m.timezone]);
 }
 await c.query('DROP TABLE metric_rollup_delta');
}

export async function maintainMetricRetention(pool:pg.Pool,now=new Date()){
 return transaction(pool,async c=>{
  // Serialize maintenance and acceptance: no acknowledged correction may be pruned before publication.
  const defs=await c.query("SELECT metric_id,version,config FROM metric_definition_versions WHERE config ? 'storagePolicy' AND config->'storagePolicy'<>'null'::jsonb ORDER BY metric_id,version");
  let deleted=0;
  for(const r of defs.rows){const m=await getMetric(c,r.metric_id,r.version),p=m.storagePolicy;if(!p)continue;
   const locked=await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) ok',[m.sourceId]);if(!locked.rows[0].ok)continue;
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric:${m.id}`]);
   const pending=await c.query(`SELECT 1 FROM metric_record_keys WHERE NOT processed AND payload->'projections' @> $1::jsonb LIMIT 1`,[JSON.stringify([{metricId:m.id,version:m.version}])]);if(pending.rowCount)continue;
   if(p.rawRetentionDays!==null){
    // Keep the complete boundary day so a correction can rebuild all its parents.
    const cutoff=(await c.query(`SELECT ${bucketSql("$1::timestamptz-($2::int*interval '1 day')",'day','$3')} t`,[now.toISOString(),p.rawRetentionDays,m.timezone])).rows[0].t;
    const removed=await c.query(`DELETE FROM metric_facts f USING(SELECT source_id,record_id,revision,observed_at FROM metric_facts WHERE metric_id=$1 AND version=$2 AND observed_at<$3 LIMIT 10000) old WHERE f.metric_id=$1 AND f.version=$2 AND (f.source_id,f.record_id,f.revision,f.observed_at)=(old.source_id,old.record_id,old.revision,old.observed_at)`,[m.id,m.version,cutoff]);deleted+=removed.rowCount??0;
    await c.query(`INSERT INTO metric_retention_watermarks VALUES($1,$2,$3) ON CONFLICT(metric_id,version) DO UPDATE SET raw_before=greatest(metric_retention_watermarks.raw_before,EXCLUDED.raw_before)`,[m.id,m.version,cutoff]);
   }
   for(const level of levels(p.baseResolution)){
    const days=level==='day'?p.dayRetentionDays:level==='hour'?p.hourRetentionDays:p.baseRetentionDays;
    const cutoff=bucketSql("$4::timestamptz-($5::int*interval '1 day')",'day','$6');
    await c.query(`DELETE FROM metric_rollups r USING(SELECT bucket,dimensions FROM metric_rollups WHERE metric_id=$1 AND version=$2 AND level=$3 AND ends_at<=${cutoff} LIMIT 10000) old WHERE r.metric_id=$1 AND r.version=$2 AND r.level=$3 AND r.bucket=old.bucket AND r.dimensions=old.dimensions`,[m.id,m.version,level,now.toISOString(),days,m.timezone]);
   }
   // Policy metrics do not use the legacy hourly materialization.
   await c.query('DELETE FROM metric_aggregate_states r USING(SELECT bucket,dimensions FROM metric_aggregate_states WHERE metric_id=$1 AND version=$2 LIMIT 10000) old WHERE r.metric_id=$1 AND r.version=$2 AND r.bucket=old.bucket AND r.dimensions=old.dimensions',[m.id,m.version]);
  }
  // Preserve compact identity hashes for idempotency. Only remove payloads once all consumers expired raw detail.
  await c.query(`WITH expired AS (SELECT r.source_id,r.record_id,r.revision FROM metric_record_keys r
   WHERE r.processed AND r.payload ? 'original' AND jsonb_array_length(coalesce(r.payload->'projections','[]'::jsonb))>0
   AND NOT EXISTS(SELECT 1 FROM metric_facts f WHERE f.source_id=r.source_id AND f.record_id=r.record_id AND f.revision=r.revision)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'projections') p LEFT JOIN metric_retention_watermarks w
    ON w.metric_id=(p->>'metricId')::uuid AND w.version=(p->>'version')::int
    WHERE w.raw_before IS NULL OR (p->>'observedAt')::timestamptz>=w.raw_before)
   LIMIT 10000)
   UPDATE metric_record_keys r SET payload=jsonb_build_object('expired',true,'projections',(SELECT jsonb_agg(jsonb_build_object('metricId',p->>'metricId','version',(p->>'version')::int,'observedAt',p->>'observedAt')) FROM jsonb_array_elements(r.payload->'projections') p)) FROM expired e
   WHERE (r.source_id,r.record_id,r.revision)=(e.source_id,e.record_id,e.revision)`);
  return {deletedFacts:deleted};
 });
}
