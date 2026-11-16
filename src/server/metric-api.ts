import {requestFunnelRun,readFunnelRun,cancelFunnelRun,retryFunnelRun} from './metrics/funnel-runs';
import {createDailyEventMetric,eventMetricJobs} from './metrics/event-metrics';
import {identifyEventPerson,authorizeEventRecords,eventDatasets,configureEventDataset,eventTimeline,eventFunnel} from './metrics/events';
import {previewPurge,purgeMetric} from './metrics/purge';
import type pg from 'pg';
import {v7 as uuid} from 'uuid';
import {check,object,text} from '@/models/metrics/validation';
import {scopedDimensions,permissions} from '@/models/permissions';
import type {MetricQuery} from '@/models/metrics/types';
import {chargeEventVolume,admin,human,type Principal} from './access';
import {catalog,getMetric,saveDefinition,saveMissingDataPolicy,ingest,coverage,metricRow} from './metrics/service';
import {queryMetric} from './metrics/query';
import {metricData,sourceHealth,goalResult} from './metrics/exploration';
import {metricDistribution} from './metrics/distribution';
import {libraryList,librarySave,libraryRun,libraryDelete} from './metrics/library';
export async function allowedMetric(pool:Pick<pg.Pool,'query'>,p:Principal,id:string,mode:'read'|'write'='read'){
 if(p.kind==='integration'){const r=await pool.query('SELECT id FROM metrics WHERE key=ANY($1::text[]) AND (key=$2 OR id::text=$2)',[p.permissions.metrics[mode],id]);check(r.rowCount,'Metric not found.',404);}
 return getMetric(pool,id);
}
export async function safeQuery(pool:pg.Pool,p:Principal,input:unknown){const b=object(input),m=await allowedMetric(pool,p,text(b.metricId,'Metric'));check(b.version===undefined||b.version===m.version,'Metric versions are not selectable.');
 const q={...b,metricId:m.id,version:m.version,dimensions:p.kind==='integration'?scopedDimensions(p.permissions,m.key,b.dimensions??{}):b.dimensions,snapshot:false} as unknown as MetricQuery;
 if(p.kind==='integration')check(!b.snapshot||p.permissions.metrics.snapshots,'Snapshot permission required.',403);
 if(b.snapshot&&p.kind==='user')return queryMetric(pool,{...q,snapshot:true},p.id);
 const result=await queryMetric(pool,q);
 if(b.snapshot&&p.kind==='integration'){const id=uuid();await pool.query('INSERT INTO warehouse_snapshots(id,app_id,metric_key,query,result) VALUES($1,$2,$3,$4,$5)',[id,p.id,m.key,q,result]);return {...result,snapshotId:id};}return result;
}
export async function metricGet(pool:pg.Pool,p:Principal,parts:string[],params:URLSearchParams){const[op,id]=parts;
 check(!['exports','export-query'].includes(op),'Metrics endpoint not found.',404);
 if(op==='event-funnel-runs'&&id)return readFunnelRun(pool,p,id,Object.fromEntries(params));
 if(op==='event-processing')return eventMetricJobs(pool,p);
 if(op==='event-datasets')return eventDatasets(pool,p);
 if(op==='catalog'){
  if(p.kind==='user')return catalog(pool,params.get('q')??'',params.get('after')??'');
  const rows=(await pool.query(`SELECT m.*,v.config || v.reporting_policy config,v.reporting_revision FROM metrics m JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version WHERE m.key=ANY($1::text[]) AND (v.config->>'name' ILIKE $2 OR m.key ILIKE $2) AND m.key>$3 ORDER BY m.key LIMIT 51`,[p.permissions.metrics.read,'%'+(params.get('q')??'').slice(0,200)+'%',params.get('after')??''])).rows;
  return {metrics:rows.slice(0,50).map(metricRow),nextCursor:rows.length>50?rows[49].key:undefined};
 }
 if(op==='ingestions'){const r=(await pool.query('SELECT id,status,record_count AS "recordCount",error,created_at AS "createdAt" FROM metric_ingestions WHERE id=$1 AND ($2::uuid IS NULL OR source_id=$2)',[id,p.kind==='integration'?p.sourceId:null])).rows[0];check(r,'Receipt not found.',404);return r;}
 if(op==='snapshots'&&p.kind==='integration'){check(p.permissions.metrics.snapshots,'Snapshot permission required.',403);const r=(await pool.query('SELECT * FROM warehouse_snapshots WHERE id=$1 AND app_id=$2',[id,p.id])).rows[0];check(r,'Snapshot not found.',404);const scope=scopedDimensions(p.permissions,r.metric_key,r.query.dimensions);check(Object.entries(scope).every(([k,v])=>r.query.dimensions?.[k]===v),'Snapshot exceeds current permission scope.',403);return r;}
 if(op==='definition'||op==='detail'){
  const metric=await allowedMetric(pool,p,id);if(p.kind==='integration')return {metric};
  const [activity,goals,data]=await Promise.all([pool.query('SELECT a.action,a.detail,a.created_at AS "createdAt",u.name AS "actorName" FROM metric_activity a LEFT JOIN warehouse_users u ON u.id=a.actor_id WHERE a.metric_id=$1 ORDER BY a.created_at DESC LIMIT 50',[metric.id]),pool.query('SELECT id,config FROM metric_goals WHERE metric_id=$1',[metric.id]),metricData(pool,metric.id)]);
  return {metric,historical:false,versions:[metric],activity:activity.rows,goals:goals.rows,data:data.rows};
 }
 human(p);
 if(op==='library')return libraryList(pool,p.id);
 if(op==='data')return metricData(pool,id,params.get('after')??'');
 if(op==='sources')return sourceHealth(pool);
 if(op==='goals')return goalResult(pool,id);
 if(op==='snapshots'){const r=(await pool.query('SELECT * FROM metric_query_snapshots WHERE id=$1',[id])).rows[0];check(r,'Snapshot not found.',404);return r;}
 check(false,'Metrics endpoint not found.',404);
}
export async function metricPost(pool:pg.Pool,p:Principal,parts:string[],input:unknown,req:Request){const[op,id]=parts,b=object(input);
 check(!['exports','export-query'].includes(op),'Metrics endpoint not found.',404);
 if(op==='event-funnel-runs')return id?(b.action==='cancel'?cancelFunnelRun(pool,p,id):b.action==='retry'?retryFunnelRun(pool,p,id):readFunnelRun(pool,p,id,b)):requestFunnelRun(pool,p,b);
 if(op==='event-processing')return createDailyEventMetric(pool,p,b);
 if(op==='event-identify')return identifyEventPerson(pool,p,b);
 if(op==='event-datasets')return configureEventDataset(pool,p,b);
 if(op==='event-timeline')return eventTimeline(pool,p,b);
 if(op==='event-funnel')return eventFunnel(pool,p,b);
 if(op==='query')return safeQuery(pool,p,b);
 if(['measurements','events','aggregates','corrections','coverage'].includes(op)){
  check(p.kind==='integration','Use an integration credential for ingestion.',403);
  if(op==='coverage'){const m=await allowedMetric(pool,p,text(b.metricKey,'Metric'),'write');scopedDimensions(p.permissions,m.key,b.dimensions,'write');return coverage(pool,p.sourceId,b);}
  if(op==='events')await chargeEventVolume(pool,p,Array.isArray(b.events)?b.events.length:0);
  const mode=op==='corrections'?String(b.mode):op;check(['measurements','events','aggregates'].includes(mode),'Invalid ingestion mode.');return ingest(pool,p.sourceId,mode,b,req.headers.get('idempotency-key')??undefined,op==='corrections',async(c,records,previous)=>{
   // Configuration can add a projection after HTTP authentication but before
   // this source's ingestion lock. Resolve its current grants inside the lock.
   const access=(await c.query('SELECT a.permissions FROM warehouse_apps a JOIN warehouse_credentials credential ON credential.app_id=a.id WHERE a.id=$1 AND a.active AND credential.id=$2 AND credential.revoked_at IS NULL AND credential.expires_at>now()',[p.id,p.credentialId])).rows[0];
   check(access,'Integration credential is no longer active.',401);p.permissions=permissions(access.permissions);
   await authorizeEventRecords(c,p,[...records,...previous]);
   // Historical projections are derived facts, not mutations of accepted envelopes.
   // Corrections must authorize their superseded dimensions as well.
   if(previous.length){const facts=await c.query('SELECT DISTINCT metric_id,dimensions FROM metric_facts WHERE source_id=$1 AND record_id=ANY($2::text[])',[p.sourceId,previous.map(r=>r.recordId)]);for(const f of facts.rows){const m=await allowedMetric(c,p,f.metric_id,'write');scopedDimensions(p.permissions,m.key,f.dimensions,'write');}}
   const checked=new Map<string,string>();
   for(const record of [...records,...previous])for(const projection of record.projections){let key=checked.get(projection.metricId);if(!key){key=(await allowedMetric(c,p,projection.metricId,'write')).key;checked.set(projection.metricId,key);}scopedDimensions(p.permissions,key,projection.dimensions,'write');}
  });
 }
 const u=human(p);
 if(op==='distribution')return metricDistribution(pool,b as unknown as MetricQuery);
 if(op==='library-run')return libraryRun(pool,p.id,text(b.id,'Saved item'));
 if(op==='library')return b.action==='delete'?libraryDelete(pool,p.id,id,Number(b.revision)):librarySave(pool,p.id,b,id);
 admin(u);
 if(op==='purge-preview')return previewPurge(pool,u,id,b);
 if(op==='purge')return purgeMetric(pool,u,id,b);
 if(op==='definitions')return saveDefinition(pool,b.definition??b,p.id,id,b.expectedRevision as number|undefined);
 if(op==='reporting-policy'){const m=await getMetric(pool,id);return saveMissingDataPolicy(pool,m.id,m.version,b.missingData,p.id,Number(b.expectedRevision));}
 if(op==='manual'){const m=await getMetric(pool,text(b.metricKey,'Metric'));check(m.inputMode==='measurements','Use the configured input mode.');return ingest(pool,m.sourceId,'measurements',{measurements:[{...b,measurementId:b.measurementId??uuid(),authorId:p.id,unit:m.unit,basis:'reported',evidence:text(b.evidence,'Evidence')}]},undefined,Number(b.revision??1)>1);}
 if(op==='datasets'){const source=(await pool.query('SELECT id FROM warehouse_apps WHERE source_id=$1 AND active',[b.sourceId])).rows[0];check(source,'Integration not found.',404);const schema=object(b.schema);check(Object.keys(schema).length>0&&Object.keys(schema).length<=50&&Object.values(schema).every(t=>['string','string?','properties','decimal','datetime'].includes(String(t))),'Invalid dataset schema.');await pool.query('INSERT INTO metric_datasets(source_id,key,version,schema) VALUES($1,$2,$3,$4)',[b.sourceId,text(b.key,'Dataset'),Number(b.version??1),schema]);return {ok:true};}
 check(false,'Metrics operation not found.',404);
}
