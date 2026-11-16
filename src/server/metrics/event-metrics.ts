import type pg from 'pg';
import {v7 as uuid} from 'uuid';
import {admin,type Principal} from '../access';
import {transaction} from '../db/metrics';
import {check,object,text} from '@/models/metrics/validation';
import {permissions} from '@/models/permissions';
import {getMetric,saveDefinitionInTransaction} from './service';
import {appendRollups} from './rollups';



export async function createDailyEventMetric(pool:pg.Pool,p:Principal,input:unknown){
 admin(p);const b=object(input),sourceId=text(b.sourceId,'Source'),datasetKey=text(b.datasetKey,'Dataset'),key=text(b.key,'Metric key');
 check(typeof b.includeHistory==='boolean','Choose whether to process retained history.');
 return transaction(pool,async c=>{
  // Serialize configuration with ingestion so new events cannot miss the new projection or grant.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);
  const app=(await c.query('SELECT * FROM warehouse_apps WHERE source_id=$1 AND active FOR UPDATE',[sourceId])).rows[0];check(app,'Active integration not found.',404);
  const dataset=(await c.query('SELECT mapping,retention_days FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[sourceId,datasetKey,b.schemaVersion])).rows[0];check(dataset,'Event dataset not found.',404);
  const field=dataset.mapping.name;
  const schemas=(await c.query('SELECT schema FROM metric_datasets WHERE source_id=$1 AND key=$2',[sourceId,datasetKey])).rows;
  check(schemas.every(r=>r.schema[field]==='string'),'All versions of this dataset must declare the same action field.');
  const prior=(await c.query('SELECT m.id FROM metrics m JOIN metric_event_processing j ON j.metric_id=m.id WHERE m.key=$1',[key])).rows[0];
  if(prior){const m=await getMetric(c,prior.id);check(m.sourceId===sourceId&&m.datasetKey===datasetKey&&m.dimensions[0]===field,'Metric key already belongs to another configuration.',409);if(b.includeHistory)await c.query("UPDATE metric_event_processing SET include_history=true,status='queued',created_at=now(),completed_at=NULL WHERE metric_id=$1 AND NOT include_history",[m.id]);return {metric:m,job:(await c.query('SELECT * FROM metric_event_processing WHERE metric_id=$1',[m.id])).rows[0]};}
  check(!(await c.query('SELECT 1 FROM metrics WHERE key=$1',[key])).rowCount,'Metric key already belongs to another configuration.',409);
  const days=dataset.retention_days;
  const metric=await saveDefinitionInTransaction(c,{key,name:text(b.name,'Name'),sourceId,datasetKey,inputMode:'events',kind:'count',unit:'events',dimensions:[field],timezone:'UTC',category:'Product analytics',status:'active',description:'Daily event occurrences by action. Counts are not unique-person conversions. All dataset schema versions sharing the action field are included.',storagePolicy:{baseResolution:'day',baseRetentionDays:Math.max(730,days),hourRetentionDays:Math.max(730,days),dayRetentionDays:Math.max(730,days),rawRetentionDays:days}},p.id);
  const grants=permissions(app.permissions);grants.metrics.read=[...new Set([...grants.metrics.read,key])];grants.metrics.write=[...new Set([...grants.metrics.write,key])];
  await c.query('UPDATE warehouse_apps SET permissions=$2,revision=revision+1 WHERE id=$1',[app.id,grants]);
  await c.query('INSERT INTO metric_event_processing(metric_id,source_id,dataset_key,name_field,status,completed_at,include_history) VALUES($1,$2,$3,$4,$5,CASE WHEN $5=\'completed\' THEN now() ELSE NULL END,$6)',[metric.id,sourceId,datasetKey,field,b.includeHistory?'queued':'completed',b.includeHistory]);
  await c.query('INSERT INTO metric_activity(id,metric_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[uuid(),metric.id,p.id,'event_processing_enabled',{includeHistory:b.includeHistory,datasetKey,actionField:field,retentionDays:days,grantIntegrationId:app.id}]);
  return {metric,job:(await c.query('SELECT * FROM metric_event_processing WHERE metric_id=$1',[metric.id])).rows[0]};
 });
}
export async function eventMetricJobs(pool:pg.Pool,p:Principal){admin(p);return {jobs:(await pool.query('SELECT j.*,m.key,v.config->>\'name\' name FROM metric_event_processing j JOIN metrics m ON m.id=j.metric_id JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version ORDER BY j.created_at DESC LIMIT 100')).rows};}

// Called only in an otherwise idle publication transaction. Each committed batch advances
// its cursor with the facts and rollups; restart/retry never re-counts accepted rows.
export async function backfillDailyEventMetric(c:pg.PoolClient,batchSize:number){
 const jobs=(await c.query("SELECT * FROM metric_event_processing WHERE status<>'completed' ORDER BY created_at LIMIT 20")).rows;
 for(const job of jobs){
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) ok',[job.source_id])).rows[0].ok)continue;
  if(!(await c.query('SELECT id FROM metric_sources WHERE id=$1 FOR UPDATE SKIP LOCKED',[job.source_id])).rowCount)continue;
  const locked=(await c.query("SELECT *,cursor_at::text cursor_text,created_at::text cutoff FROM metric_event_processing WHERE metric_id=$1 AND status<>'completed' FOR UPDATE SKIP LOCKED",[job.metric_id])).rows[0];if(!locked)continue;
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric:${job.metric_id}`]);
  try{
  const m=await getMetric(c,job.metric_id);
  const rows=(await c.query(`SELECT r.*,r.received_at::text received_text FROM metric_record_keys r
   WHERE r.source_id=$1 AND (r.received_at,r.record_id,r.revision)>($2::timestamptz,$3,$4)
   AND r.received_at<=$5::timestamptz AND r.payload->'original'->>'mode'='events' AND r.payload->'original'->>'datasetKey'=$6
   ORDER BY r.received_at,r.record_id,r.revision LIMIT $7`,[job.source_id,locked.cursor_text,locked.cursor_id,locked.cursor_revision,locked.cutoff,job.dataset_key,batchSize])).rows;
  await c.query('CREATE TEMP TABLE metric_new (LIKE metric_facts INCLUDING DEFAULTS) ON COMMIT DROP');
  const records=rows.flatMap(row=>{
   const record=row.payload.original?.record,name=record?.data?.[job.name_field];
   if(typeof name!=='string'||!name.trim()||name.length>200||!Number.isFinite(Date.parse(record?.occurredAt)))return [];
   return [{record_id:row.record_id,revision:row.revision,observed_at:new Date(record.occurredAt).toISOString(),name,received_at:row.received_text}];
  });
  // Publish only new derived facts. The source/metric locks exclude concurrent
  // publication, corrections, purge and retention; the receipt cutoff bounds work.
  const added=await c.query(`INSERT INTO metric_new(source_id,record_id,revision,metric_id,version,observed_at,ends_at,dimensions,v,n,d,weight,identity,received_at)
   SELECT $1,p.record_id,p.revision,$2,$3,p.observed_at,NULL,jsonb_build_object($4::text,p.name),1,0,0,1,NULL,p.received_at
   FROM jsonb_to_recordset($5::jsonb) p(record_id text,revision int,observed_at timestamptz,name text,received_at timestamptz)
   WHERE p.observed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-make_interval(days=>$6)
   AND NOT EXISTS(SELECT 1 FROM metric_record_keys r WHERE r.source_id=$1 AND r.record_id=p.record_id AND r.revision>p.revision)
   AND NOT EXISTS(SELECT 1 FROM metric_facts f WHERE f.source_id=$1 AND f.record_id=p.record_id AND f.metric_id=$2)
   AND NOT EXISTS(SELECT 1 FROM metric_purged_records d WHERE d.source_id=$1 AND d.record_id=p.record_id AND d.metric_id=$2)
   AND NOT EXISTS(SELECT 1 FROM metric_retention_watermarks w WHERE w.metric_id=$2 AND w.raw_before>p.observed_at)`,[job.source_id,m.id,m.version,job.name_field,JSON.stringify(records),m.storagePolicy!.rawRetentionDays]);
  const inserted=added.rowCount??0,skipped=rows.length-inserted;
  await c.query('INSERT INTO metric_dimension_sets(metric_id,version,dimensions) SELECT DISTINCT metric_id,version,dimensions FROM metric_new ON CONFLICT DO NOTHING');
  const count=Number((await c.query('SELECT count(*) n FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2',[m.id,m.version])).rows[0].n);check(count<=m.maxSeries,'Series cardinality budget exceeded during event history processing.');
  await c.query('INSERT INTO metric_facts SELECT * FROM metric_new');
  await appendRollups(c,m);
  await c.query('UPDATE metric_registrations SET has_data=true WHERE metric_id=$1 AND $2>0',[m.id,inserted]);
  const last=rows.at(-1),completed=rows.length<batchSize;
  await c.query(`UPDATE metric_event_processing SET last_error=NULL,status=$2,scanned=scanned+$3,inserted=inserted+$4,skipped=skipped+$5,
   cursor_at=coalesce($6::timestamptz,cursor_at),cursor_id=coalesce($7,cursor_id),cursor_revision=coalesce($8,cursor_revision),completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END WHERE metric_id=$1`,[m.id,completed?'completed':'running',rows.length,inserted,skipped,last?.received_text??null,last?.record_id??null,last?.revision??null]);
  return Math.max(1,rows.length);
  }catch(error){throw Object.assign(error instanceof Error?error:new Error('History processing failed'),{eventMetricId:job.metric_id});}
 }
 return 0;
}
