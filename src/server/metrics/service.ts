import {eventFields} from '@/models/metrics/events';
import { assertMetricContract } from '@/models/metrics/definition-contract';
import { bucketSql,endSql } from './resolution-sql';
import { createHash } from 'node:crypto';
import { v7 as uuid } from 'uuid';
import type pg from 'pg';
import { transaction } from '@/server/db/metrics';
import { canonical, check, decimal, definition, dimensionValues, instant, object, text } from '@/models/metrics/validation';
import type { Metric, MetricCatalog } from '@/models/metrics/types';
export const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export type SqlClient=Pick<pg.Pool,'query'>;
export function metricRow(r:Record<string,unknown>):Metric{return{...r.config as Metric,revision:Number(r.revision??1),reportingRevision:Number(r.reporting_revision??0),id:String(r.id),version:Number(r.version),ownerId:String(r.owner_id),createdAt:new Date(String(r.created_at)).toISOString()};}
export async function getMetric(c:SqlClient,id:string,version?:number){
 check(version===undefined||(Number.isSafeInteger(version)&&version>0),'Invalid legacy definition version.');
 const r=await c.query(`SELECT resolved.id,resolved.owner_id,resolved.created_at,resolved.revision,v.version,v.config || v.reporting_policy AS config,v.reporting_revision
 FROM metrics requested
 LEFT JOIN metric_definition_aliases a ON a.original_metric_id=requested.id AND a.original_version=$2
 JOIN metrics resolved ON resolved.id=COALESCE(a.metric_id,requested.id)
 JOIN metric_definition_versions v ON v.metric_id=resolved.id AND v.version=COALESCE(a.version,$2,resolved.version)
 WHERE requested.id::text=$1 OR requested.key=$1`,[id,version??null]);
 check(r.rows[0],version===undefined?'Metric not found.':'Legacy definition not found. Use the stable metric key without definitionVersion.',404);return metricRow(r.rows[0]);
}
export async function catalog(c:SqlClient,search='',after=''):Promise<MetricCatalog>{const [m,s,i,e]=await Promise.all([c.query("SELECT m.*,v.config || v.reporting_policy AS config,v.reporting_revision FROM metrics m JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version WHERE (v.config->>'name' ILIKE $1 OR m.key ILIKE $1 OR v.config->>'category' ILIKE $1) AND ($2='' OR m.id::text>$2) ORDER BY m.id LIMIT 201",['%'+search.slice(0,200)+'%',after]),c.query('SELECT id,name,owner_id AS "ownerId",active,created_at AS "createdAt" FROM metric_sources ORDER BY name'),c.query('SELECT id,status,record_count AS "recordCount",created_at AS "createdAt",error FROM metric_ingestions ORDER BY created_at DESC LIMIT 30'),c.query('SELECT id,metric_id AS "metricId",status,opened_at AS "openedAt",value::text FROM metric_alert_episodes ORDER BY updated_at DESC LIMIT 30')]);return {metrics:m.rows.slice(0,200).map(metricRow),nextCursor:m.rows.length>200?m.rows[199].id:undefined,sources:s.rows,ingestions:i.rows,episodes:e.rows};}
export async function createSource(pool:pg.Pool,name:string,owner:string){
 const label=text(name,'Name');
 return transaction(pool,async c=>{
  // Serialize even separate requests/tabs before checking the active source name.
  await c.query('SELECT pg_advisory_xact_lock(hashtext(lower($1)))',[`metric-source-name:${label}`]);
  const existing=await c.query('SELECT id FROM metric_sources WHERE active AND lower(btrim(name))=lower($1) LIMIT 1',[label]);
  check(!existing.rowCount,'An active source with this name already exists. Manage its integration instead.',409);
  const id=uuid();await c.query('INSERT INTO metric_sources(id,name,owner_id) VALUES($1,$2,$3)',[id,label,owner]);
  return{id};
 });
}
export async function saveDefinition(pool:pg.Pool,input:unknown,actor:string,id?:string,expectedRevision?:number){
 return transaction(pool,c=>saveDefinitionInTransaction(c,input,actor,id,expectedRevision));
}
// Callers that grant ownership/access must commit those changes with the definition.
export async function saveDefinitionInTransaction(c:SqlClient,input:unknown,actor:string,id?:string,expectedRevision?:number){
 const sourceId=id?(await getMetric(c,id)).sourceId:undefined;
  const metricId=id||uuid();let config;let previous;let revision=1;
  if(id){
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);
   const r=await c.query('SELECT * FROM metrics WHERE id=$1 FOR UPDATE',[id]);
   check(r.rows[0],'Metric not found.',404);
   check(Number.isSafeInteger(expectedRevision)&&r.rows[0].revision===expectedRevision,'Metric settings changed. Refresh before editing (expectedRevision is required).',409);
   previous=await getMetric(c,id);config=definition({...previous,...object(input)});
   assertMetricContract(definition(previous),config);
   const count=await c.query('SELECT count(*) n FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2',[id,previous.version]);
   check(Number(count.rows[0].n)<=config.maxSeries,'Maximum series cannot be lower than the existing series count.');
   revision=r.rows[0].revision+1;
   await c.query('UPDATE metrics SET revision=$2 WHERE id=$1',[id,revision]);
   await c.query('UPDATE metric_definition_versions SET config=$3 WHERE metric_id=$1 AND version=$2',[id,previous.version,config]);
  }else{
   config=definition(input);
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric-key:${config.key}`]);
   const reserved=await c.query('SELECT 1 FROM metric_registrations WHERE key=$1 AND deleted_at IS NOT NULL',[config.key]);
   check(!reserved.rowCount,'This deleted metric key is reserved. Use a new key.',409);
   await c.query('INSERT INTO metrics(id,key,version,owner_id) VALUES($1,$2,1,$3)',[metricId,config.key,actor]);
   await c.query('INSERT INTO metric_definition_versions(metric_id,version,config) VALUES($1,1,$2)',[metricId,config]);
  }
  if(!previous||previous.status!==config.status&&config.status==='active'){
   const source=await c.query('SELECT id FROM metric_sources WHERE id=$1 AND active',[config.sourceId]);check(source.rowCount,'Choose an active source.');
  }
  await c.query('INSERT INTO metric_activity(id,metric_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[uuid(),metricId,actor,previous?'settings_updated':'definition_created',{revision,previous:previous?definition(previous):undefined,definition:config}]);
  return getMetric(c,metricId);
}
// Reporting changes do not create an empty ingestion version. Snapshots retain the effective policy.
export async function saveMissingDataPolicy(pool:pg.Pool,id:string,version:number,input:unknown,actor:string,expectedRevision:number){
 const missingData=String(input);
 check(['leave_gaps','keep_previous'].includes(missingData),'Choose Leave gaps or Keep previous value.');
 check(Number.isSafeInteger(version)&&version>0&&Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'Supply definition version and reporting revision.');
 return transaction(pool,async c=>{
  const metric=await getMetric(c,id,version);
  check(metric.kind==='latest','Missing-data policy is available for latest snapshot metrics only.');
  const updated=await c.query("UPDATE metric_definition_versions SET reporting_policy=jsonb_build_object('missingData',$3::text),reporting_revision=reporting_revision+1 WHERE metric_id=$1 AND version=$2 AND reporting_revision=$4 RETURNING reporting_revision",[id,version,missingData,expectedRevision]);
  check(updated.rowCount,'Reporting policy changed. Refresh before saving.',409);
  await c.query('INSERT INTO metric_activity(id,metric_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[uuid(),id,actor,'missing_data_policy_updated',{version,previous:metric.missingData??'leave_gaps',missingData,reportingRevision:updated.rows[0].reporting_revision}]);
  return getMetric(c,id,version);
 });
}
export type Projection={metricId:string;version:number;observedAt:string;endsAt:string|null;dimensions:Record<string,string>;v:string|null;n:string;d:string;weight:string;identity:string|null};
export type Envelope={recordId:string;revision:number;projections:Projection[];original:unknown;tombstone?:boolean};
function projection(m:Metric,r:Record<string,unknown>,mode:string):Projection {
 check(m.status==='active','Metric is not active.');check(m.inputMode===mode,'This metric has a different authoritative input mode; overlapping inputs are not allowed.');
 const interval=mode==='aggregates'||!!r.startsAt;const observedAt=instant(interval?r.startsAt:r.observedAt??r.occurredAt),endsAt=interval?instant(r.endsAt):null;check(!endsAt||endsAt>observedAt,'Interval end must follow start.');
 if(mode!=='events')check(r.unit===m.unit,'Measurement unit must match the definition.');
 const values=mode==='events'?object(r.data):r;
 const dims=mode==='events'?Object.fromEntries(m.dimensions.map(k=>[k,values[k]])):r.dimensions;
 const p:Projection={metricId:m.id,version:m.version,observedAt,endsAt,dimensions:dimensionValues(dims,m.dimensions),v:null,n:'0',d:'0',weight:'1',identity:null};
 if(mode==='aggregates'){
  const state=object(r.state);check(state.kind===m.kind,'Aggregate state must match the metric kind.');
  if(m.kind==='mean'){p.n=decimal(state.sum);p.d=decimal(String(state.count));check(Number(p.d)>0&&Number.isInteger(Number(p.d)),'Count must be a positive integer.');p.weight=p.d;}
  else if(m.kind==='ratio'){p.n=decimal(state.numerator);p.d=decimal(state.denominator);check(Number(p.d)>=0,'Denominator cannot be negative.');}
  else if(m.kind==='latest'){check(false,'Send snapshots through measurements, not aggregate intervals.');}
  else {p.v=decimal(state.value??state.sum??String(state.count));if(m.kind==='count')check(Number.isInteger(Number(p.v))&&Number(p.v)>=0,'Count must be a nonnegative integer.');}
 }else if(m.kind==='ratio'){p.n=decimal(values[mode==='events'?m.numeratorField:'numerator']);p.d=decimal(values[mode==='events'?m.denominatorField:'denominator']);check(Number(p.d)>=0,'Denominator cannot be negative.');}
 else if(m.kind==='distinct'){p.identity=text(values[mode==='events'?m.identityField:'identity'],'Distinct identity',200);}
 else if(m.kind==='count'){p.v='1';}
 else {p.v=decimal(values[mode==='events'?m.valueField:'value']);if(m.kind==='mean'){p.n=p.v;p.d='1';}}
 check(!endsAt||!['latest','distinct','p95'].includes(m.kind),'This metric requires point observations.');return p;
}
export async function normalize(c:SqlClient,sourceId:string,mode:string,input:unknown):Promise<Envelope[]>{const b=object(input);const list=b[mode]??b.events;check(Array.isArray(list)&&list.length>0&&list.length<=1000,'Submit between 1 and 1,000 records.');check(Buffer.byteLength(JSON.stringify(input))<=5*1024*1024,'Batch exceeds 5 MiB.',413);
 let behavior:{mapping:import('@/models/metrics/events').EventMapping}|undefined;
 let defs:Metric[]=[];if(mode==='events'){const dataset=text(b.datasetKey,'Dataset');const schema=await c.query('SELECT schema FROM metric_datasets WHERE source_id=$1 AND key=$2 AND version=$3',[sourceId,dataset,Number(b.schemaVersion)]);check(schema.rows[0],'Register the dataset schema before ingestion.');const result=await c.query("SELECT m.*,v.config || v.reporting_policy AS config,v.reporting_revision FROM metrics m JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version WHERE v.config->>'sourceId'=$1 AND v.config->>'datasetKey'=$2 AND v.config->>'inputMode'='events' AND v.config->>'status'='active'",[sourceId,dataset]);defs=result.rows.map(metricRow);behavior=(await c.query('SELECT mapping FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[sourceId,dataset,Number(b.schemaVersion)])).rows[0];check(defs.length||behavior,'No active metrics consume this dataset and event exploration is not enabled.');check(defs.length*list.length<=100000,'Dataset fan-out exceeds the per-batch projection budget. Split the batch.');
 const fields=object(schema.rows[0].schema);for(const item of list){const data=object(object(item).data);check(Object.keys(data).every(k=>k in fields),'Undeclared dataset field.');for(const[k,t]of Object.entries(fields)){check(k in data,`Missing dataset field ${k}.`);if(t==='decimal')decimal(data[k]);else if(t==='datetime')instant(data[k]);else if(t==='string'||t==='string?'){if(t==='string'||data[k]!==null)text(data[k],k,1000);}else if(t==='properties'){const props=object(data[k]);check(Object.keys(props).length<=50&&Object.entries(props).every(([key,v])=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)&&(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=1000)),'Use up to 50 scalar event properties.');}else check(false,'Unsupported schema type.');}}
 }
 const cache=new Map<string,Metric>();const out:Envelope[]=[];
 for(const item of list){const r=object(item);const recordId=text(r.eventId??r.measurementId??r.aggregateId,'Record identity',200);const revision=Number(r.revision??1);check(Number.isSafeInteger(revision)&&revision>0,'Invalid revision.');let projections:Projection[];
 if(mode==='events'){if(behavior)eventFields(r,behavior.mapping);const data=object(r.data);projections=defs.filter(m=>Object.entries(m.filters).every(([k,v])=>String(data[k])===v)).map(m=>projection(m,r,mode));}
 else {check(r.definitionVersion===undefined||(Number.isSafeInteger(Number(r.definitionVersion))&&Number(r.definitionVersion)>0),'Invalid legacy definition version.');const key=text(r.metricKey,'Metric');const cacheKey=`${key}:${r.definitionVersion}`;let m=cache.get(cacheKey);if(!m){m=await getMetric(c,key,r.definitionVersion===undefined?undefined:Number(r.definitionVersion));cache.set(cacheKey,m);}check(m.sourceId===sourceId,'Metric is not authorized for this integration. Use the Warehouse credential belonging to its configured publisher.',403);projections=[projection(m,r,mode)];}
 out.push({recordId,revision,projections,original:{...b,mode,...(mode==='events'?{datasetKey:text(b.datasetKey,'Dataset'),schemaVersion:Number(b.schemaVersion)}:{}),[mode]:undefined,events:undefined,record:r}});
 }return out;
}
export function recordSemanticHash(record:Envelope){
 const original=object(record.original);const sourceRecord=original.record?{...object(original.record)}:undefined;
 if(sourceRecord){delete sourceRecord.definitionVersion;delete sourceRecord.metricKey;}
 return hash(JSON.parse(JSON.stringify({...original,...(sourceRecord?{record:sourceRecord}:{})})));
}
function sameRecordTargets(left:Envelope,right:Envelope){
 const targets=(record:Envelope)=>record.projections.map(p=>`${p.metricId}:${p.version}`).sort();
 return canonical(targets(left))===canonical(targets(right));
}
export async function ingest(pool:pg.Pool,sourceId:string,mode:string,input:unknown,requestKey?:string,correction=false,authorize?:(c:SqlClient,records:Envelope[],previous:Envelope[])=>Promise<void>){const requestHash=hash({mode,input});return transaction(pool,async c=>{
 // Serialize only this source's short acceptance transaction, never the company workflow.
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);
 if(requestKey){check(requestKey.length<=200,'Idempotency key too long.');const old=await c.query('SELECT * FROM metric_ingestions WHERE source_id=$1 AND request_key=$2',[sourceId,requestKey]);if(old.rows[0]){check(old.rows[0].payload_hash===requestHash,'Idempotency key conflicts with another payload.',409);return{id:old.rows[0].id,status:old.rows[0].status,duplicate:true};}}
 const pending=await c.query('SELECT count(*) n FROM (SELECT 1 FROM metric_record_keys WHERE source_id=$1 AND NOT processed LIMIT 100001) x',[sourceId]);check(Number(pending.rows[0].n)<100000,'Source backlog limit reached. Retry after the worker catches up.',429);
 const raw=object(input);let records:Envelope[];
 if(correction&&raw.tombstone===true){const recordId=text(raw.recordId,'Record identity');const revision=Number(raw.revision);check(Number.isSafeInteger(revision)&&revision>1,'Tombstone requires the next revision.');records=[{recordId,revision,projections:[],original:{tombstone:true,recordId,revision,reason:text(raw.reason,'Correction reason',2000)},tombstone:true}];}else records=await normalize(c,sourceId,mode,input);const ids=records.map(r=>r.recordId);const existing=await c.query('SELECT DISTINCT ON(record_id) record_id,revision,hash,semantic_hash,payload FROM metric_record_keys WHERE source_id=$1 AND record_id=ANY($2) ORDER BY record_id,revision DESC',[sourceId,ids]);const prior=new Map(existing.rows.map(r=>[r.record_id,r]));const historical=await c.query('SELECT record_id,revision,hash,semantic_hash,payload FROM metric_record_keys WHERE source_id=$1 AND record_id=ANY($2)',[sourceId,ids]);const historicalHashes=new Map(historical.rows.map(r=>[`${r.record_id}:${r.revision}`,r]));const unique=new Map<string,Envelope>();
 // Authorize both incoming and superseded projections inside the ingestion transaction.
 if(authorize)await authorize(c,records,existing.rows.map(r=>r.payload as Envelope));
 for(const record of records){const key=record.recordId;const r=prior.get(key);const h=hash(record.original);if(unique.has(key)){check(sameRecordTargets(unique.get(key)!,record)&&recordSemanticHash(unique.get(key)!)===recordSemanticHash(record),'Conflicting duplicate identity in batch.',409);continue;}const existingHash=historicalHashes.get(`${key}:${record.revision}`);if(existingHash){check(existingHash.hash===h||(sameRecordTargets(existingHash.payload,record)&&(existingHash.semantic_hash??(existingHash.payload?.original?recordSemanticHash(existingHash.payload):undefined))===recordSemanticHash(record)),'Record identity has different content.',409);continue;}if(r){if(record.revision!==r.revision)check(!r.payload?.expired,'The raw correction window has expired for this record.',409);if(record.revision===r.revision){check(r.hash===h,'Record identity has different content.',409);continue;}check(correction&&record.revision===r.revision+1,'Use a correction with the next revision.',409);}else check(record.revision===1,'First revision must be 1.');unique.set(key,record);}
 const projections=[...unique.values()].flatMap(r=>r.projections.map(p=>({...p,recordId:r.recordId})));
 const purged=await c.query(`SELECT 1 FROM metric_purged_records d JOIN jsonb_to_recordset($1::jsonb) p("recordId" text,"metricId" uuid,version int)
  ON d.record_id=p."recordId" AND d.metric_id=p."metricId" AND d.version=p.version WHERE d.source_id=$2 LIMIT 1`,[JSON.stringify(projections),sourceId]);
 check(!purged.rowCount,'This record was purged from the metric. Publish intentionally new data with a new record identity.',409);

 const expired=await c.query(`WITH candidate AS(SELECT p FROM jsonb_array_elements($1::jsonb) p UNION ALL SELECT p FROM metric_record_keys r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p WHERE r.source_id=$2 AND r.record_id=ANY($3)) SELECT 1 FROM candidate JOIN metric_retention_watermarks w ON w.metric_id=(p->>'metricId')::uuid AND w.version=(p->>'version')::int WHERE (p->>'observedAt')::timestamptz<w.raw_before LIMIT 1`,[JSON.stringify(projections),sourceId,[...unique.keys()]]);
 check(!expired.rowCount,'The raw correction window has expired for this record. Retained aggregates cannot rebuild expired detail.',409);
 // Only interval inputs need alignment checks. Validate all intervals for a version in one query.
 const intervalGroups=new Map<string,typeof projections>();
 for(const p of projections){if(!p.endsAt)continue;const key=p.metricId+':'+p.version;const group=intervalGroups.get(key)??[];group.push(p);intervalGroups.set(key,group);}
 for(const group of intervalGroups.values()){
  const m=await getMetric(c,group[0].metricId,group[0].version);if(!m.storagePolicy)continue;
  const b=bucketSql('p."observedAt"',m.storagePolicy.baseResolution,'$2');
  const aligned=await c.query(`SELECT bool_and(p."observedAt"=${b} AND p."endsAt"=${endSql(b,m.storagePolicy.baseResolution,'$2')}) ok
   FROM jsonb_to_recordset($1::jsonb) p("observedAt" timestamptz,"endsAt" timestamptz) WHERE $2::text IS NOT NULL`,
   [JSON.stringify(group.map(p=>({observedAt:p.observedAt,endsAt:p.endsAt}))),m.timezone]);
  check(aligned.rows[0].ok,'Source interval must exactly match one configured base bucket.');
 }

 if(projections.length){
 await c.query('UPDATE metric_registrations SET has_data=true WHERE metric_id=ANY($1::uuid[]) AND NOT has_data',[[...new Set(projections.map(p=>p.metricId))]]);
 await c.query(`INSERT INTO metric_dimension_sets(metric_id,version,dimensions) SELECT DISTINCT (p->>'metricId')::uuid,(p->>'version')::int,p->'dimensions' FROM jsonb_array_elements($1::jsonb) p ON CONFLICT DO NOTHING`,[JSON.stringify(projections)]);
 const budgets=await c.query(`SELECT s.metric_id,count(*) n,(v.config->>'maxSeries')::int budget FROM metric_dimension_sets s JOIN metric_definition_versions v ON v.metric_id=s.metric_id AND v.version=s.version WHERE s.metric_id=ANY($1::uuid[]) GROUP BY s.metric_id,s.version,v.config`,[[...new Set(projections.map(p=>p.metricId))]]);check(budgets.rows.every(r=>Number(r.n)<=r.budget),'Series cardinality budget exceeded.');}
 const mayOverlap=mode!=='events'&&projections.length&&(projections.some(p=>p.endsAt)||(await c.query("SELECT 1 FROM metric_record_keys WHERE source_id=$1 AND jsonb_path_exists(payload,'$.projections[*] ? (@.endsAt != null)') LIMIT 1",[sourceId])).rowCount);
 if(mayOverlap){
  const incoming=JSON.stringify(projections);
  const overlap=await c.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) x("recordId" text,"metricId" uuid,version int,"observedAt" timestamptz,"endsAt" timestamptz,dimensions jsonb)), existing AS (SELECT r.record_id,p FROM metric_record_keys r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p WHERE r.source_id=$2 AND NOT EXISTS(SELECT 1 FROM metric_record_keys n WHERE n.source_id=r.source_id AND n.record_id=r.record_id AND n.revision>r.revision) AND NOT(r.record_id=ANY($3)))
  SELECT 1 FROM incoming a JOIN existing b ON b.p->>'metricId'=a."metricId"::text AND (b.p->>'version')::int=a.version AND b.p->'dimensions'=a.dimensions WHERE (a."endsAt" IS NOT NULL OR b.p->>'endsAt' IS NOT NULL) AND a."observedAt"<COALESCE((b.p->>'endsAt')::timestamptz,(b.p->>'observedAt')::timestamptz+interval '1 microsecond') AND COALESCE(a."endsAt",a."observedAt"+interval '1 microsecond')>(b.p->>'observedAt')::timestamptz
  UNION ALL SELECT 1 FROM incoming a JOIN incoming b ON a."recordId"<b."recordId" AND a."metricId"=b."metricId" AND a.version=b.version AND a.dimensions=b.dimensions WHERE (a."endsAt" IS NOT NULL OR b."endsAt" IS NOT NULL) AND a."observedAt"<COALESCE(b."endsAt",b."observedAt"+interval '1 microsecond') AND COALESCE(a."endsAt",a."observedAt"+interval '1 microsecond')>b."observedAt" LIMIT 1`,[incoming,sourceId,[...unique.keys()]]);check(!overlap.rowCount,'Overlapping interval contributions would double count this series.',409);
 }
 const id=uuid();await c.query('INSERT INTO metric_ingestions(id,source_id,request_key,payload_hash,record_count,status,completed_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5=0 THEN now() END)',[id,sourceId,requestKey??null,requestHash,unique.size,unique.size?'accepted':'completed']);
 const rows=[...unique.values()].map(r=>({record_id:r.recordId,revision:r.revision,hash:hash(r.original),semantic_hash:recordSemanticHash(r),payload:r}));
 if(rows.length)await c.query(`INSERT INTO metric_record_keys(source_id,record_id,revision,hash,semantic_hash,ingestion_id,payload) SELECT $1,x.record_id,x.revision,x.hash,x.semantic_hash,$2,x.payload FROM jsonb_to_recordset($3::jsonb) x(record_id text,revision integer,hash text,semantic_hash text,payload jsonb)`,[sourceId,id,JSON.stringify(rows)]);
 return{id,status:rows.length?'accepted':'completed',accepted:rows.length,duplicates:records.length-rows.length};});}
export async function coverage(pool:pg.Pool,sourceId:string,input:unknown){return transaction(pool,async c=>{
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);
 const r=object(input),m=await getMetric(c,text(r.metricKey,'Metric'),r.definitionVersion===undefined?undefined:Number(r.definitionVersion));
 check(m.sourceId===sourceId,'Source not authorized.',403);
 const dims=dimensionValues(r.dimensions,m.dimensions),start=instant(r.startsAt),end=instant(r.endsAt);
 check(end>start,'Invalid coverage range.');
 await c.query('UPDATE metric_registrations SET has_data=true WHERE metric_id=$1 AND NOT has_data',[m.id]);
 await c.query('INSERT INTO metric_coverage(source_id,metric_id,version,dimensions,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[sourceId,m.id,m.version,dims,start,end]);
 return{ok:true};
});}
