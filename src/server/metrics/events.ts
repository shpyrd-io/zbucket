import type pg from 'pg';
import {DomainError} from '@/models/policy';
import {admin,type Principal} from '../access';
import {transaction} from '../db/metrics';
import {canonical,check,instant,object,text} from '@/models/metrics/validation';
import {eventMapping,evaluateFunnel,funnelSteps,type EventDataset,type FunnelEvent} from '@/models/metrics/events';
import type {Envelope,SqlClient} from './service';

function grant(p:Principal,sourceId:string,key:string,mode:'read'|'write'){
 if(p.kind==='user')return;
 check(p.sourceId===sourceId&&(mode==='read'?p.permissions.metrics.eventRead:p.permissions.metrics.eventWrite)?.includes(key),'Event dataset access denied.',403);
}
export async function authorizeEventRecords(c:SqlClient,p:Principal,records:Envelope[]){
 const checked=new Set<string>();
 for(const record of records){const o=record.original as {mode?:string;datasetKey?:string;schemaVersion?:number};if(!o||o.mode!=='events'||!o.datasetKey)continue;
  const key=JSON.stringify([o.datasetKey,o.schemaVersion]);if(checked.has(key))continue;checked.add(key);
  check(p.kind==='integration','Use an integration credential.',403);
  const enabled=await c.query('SELECT 1 FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[p.sourceId,o.datasetKey,o.schemaVersion]);
  if(enabled.rowCount)grant(p,p.sourceId,o.datasetKey,'write');
 }
}
// Trusted backend only: aliases are immutable, dataset-scoped and never merge accounts.
export async function identifyEventPerson(pool:pg.Pool,p:Principal,input:unknown){
 check(p.kind==='integration','Use an integration credential.',403);
 const b=object(input),key=text(b.datasetKey,'Dataset'),version=Number(b.schemaVersion),anonymous=text(b.anonymousId,'Anonymous ID'),user=text(b.userId,'User ID');
 grant(p,p.sourceId,key,'write');check(/^anon:[a-f0-9-]{36}$/.test(anonymous)&&user.startsWith('user:')&&user.length>5,'Use namespaced browser identities.');
 return transaction(pool,async c=>{
  const config=(await c.query('SELECT mapping FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[p.sourceId,key,version])).rows[0];check(config?.mapping.userId,'Dataset must map a person.',422);
  await c.query('INSERT INTO metric_event_identities(source_id,dataset_key,schema_version,anonymous_id,user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[p.sourceId,key,version,anonymous,user]);
  const row=(await c.query('SELECT user_id FROM metric_event_identities WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3 AND anonymous_id=$4',[p.sourceId,key,version,anonymous])).rows[0];check(row.user_id===user,'Anonymous identity is already linked to a different user.',409);return {linked:true};
 });
}
export async function eventDatasets(pool:pg.Pool,p:Principal){
 const r=await pool.query(`SELECT d.source_id AS "sourceId",d.key AS "datasetKey",d.version AS "schemaVersion",d.schema,
 s.name AS "sourceName",e.mapping,e.retention_days AS "retentionDays",e.backfilled,e.skipped_records AS "skippedRecords"
 FROM metric_datasets d JOIN metric_sources s ON s.id=d.source_id
 LEFT JOIN metric_event_datasets e ON e.source_id=d.source_id AND e.dataset_key=d.key AND e.schema_version=d.version
 WHERE ($1::uuid IS NULL OR d.source_id=$1 AND d.key=ANY($2::text[]) AND e.source_id IS NOT NULL)
 ORDER BY s.name,d.key,d.version`,[p.kind==='integration'?p.sourceId:null,p.kind==='integration'?p.permissions.metrics.eventRead??[]:[]]);
 return {datasets:r.rows};
}
export async function configureEventDataset(pool:pg.Pool,p:Principal,input:unknown){
 admin(p);const b=object(input),sourceId=text(b.sourceId,'Source'),datasetKey=text(b.datasetKey,'Dataset'),schemaVersion=Number(b.schemaVersion),retentionDays=Number(b.retentionDays??90);
 check(Number.isSafeInteger(schemaVersion)&&schemaVersion>0,'Invalid schema version.');check(Number.isInteger(retentionDays)&&retentionDays>=1&&retentionDays<=3650,'Retention must be 1–3,650 days.');
 return transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sourceId]);
  const schema=(await c.query('SELECT schema FROM metric_datasets WHERE source_id=$1 AND key=$2 AND version=$3',[sourceId,datasetKey,schemaVersion])).rows[0];check(schema,'Dataset not found.',404);
  const mapping=eventMapping(b.mapping,schema.schema);
  const previous=(await c.query('SELECT mapping,retention_days FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[sourceId,datasetKey,schemaVersion])).rows[0];
  if(previous){check(canonical(previous.mapping)===canonical(mapping)&&previous.retention_days===retentionDays,'Event mappings and retention are immutable. Register a new dataset schema version.',409);return {configured:true};}
  await c.query('INSERT INTO metric_event_datasets(source_id,dataset_key,schema_version,mapping,retention_days) VALUES($1,$2,$3,$4,$5)',[sourceId,datasetKey,schemaVersion,mapping,retentionDays]);return {configured:true};
 });
}
export async function eventScope(c:SqlClient,p:Principal,b:Record<string,unknown>){
 const sourceId=p.kind==='integration'?p.sourceId:text(b.sourceId,'Source'),datasetKey=text(b.datasetKey,'Dataset'),version=Number(b.schemaVersion);
 if(p.kind==='integration'&&b.sourceId!==undefined)check(b.sourceId===sourceId,'Event dataset access denied.',403);
 grant(p,sourceId,datasetKey,'read');check(Number.isSafeInteger(version)&&version>0,'Invalid schema version.');
 const config=(await c.query('SELECT * FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[sourceId,datasetKey,version])).rows[0];check(config,'Event exploration is not enabled for this dataset.',404);
 const start=instant(b.startsAt),end=instant(b.endsAt);check(end>start&&Date.parse(end)-Date.parse(start)<=366*86400000,'Choose a period of at most 366 days.');
 const floor=new Date(Date.now()-config.retention_days*86400000).toISOString();check(start>=floor,'Requested event detail has expired. Choose a period within dataset retention.');
 const pending=(await c.query(`SELECT EXISTS(SELECT 1 FROM metric_record_keys WHERE source_id=$1 AND NOT processed AND payload->'original'->>'datasetKey'=$2 AND payload->'original'->>'schemaVersion'=$3) pending`,[sourceId,datasetKey,String(version)])).rows[0].pending;
 return {sourceId,datasetKey,version,start,end,config,metadata:{recomputing:!config.backfilled||pending,skippedRecords:config.skipped_records,retainedSince:floor}};
}
const baseWhere=`e.source_id=$1 AND e.dataset_key=$2 AND e.schema_version=$3 AND e.occurred_at >= $4 AND e.occurred_at < $5`;
const originalJoin=`JOIN metric_record_keys r ON (r.source_id,r.record_id,r.revision)=(e.source_id,e.record_id,e.revision)`;
const identityJoin=`LEFT JOIN metric_event_identities identity ON (identity.source_id,identity.dataset_key,identity.schema_version,identity.anonymous_id)=(e.source_id,e.dataset_key,e.schema_version,e.user_id)`;
const personSql='coalesce(identity.user_id,e.user_id)';
async function readTransaction<T>(pool:pg.Pool,fn:(c:pg.PoolClient)=>Promise<T>){
 try{return await transaction(pool,async c=>{await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='5s'");return fn(c);});}
 catch(error){if((error as {code?:string}).code==='57014')throw new DomainError(422,'Event query exceeded its time budget. Choose a shorter period or narrower filters.');throw error;}
}
// Resolve indexed identities before loading payloads. Each identity contributes at
// most one page; merging those pages preserves global keyset ordering.
export function eventTimelineSql(person:boolean){
 const filters=`${baseWhere} AND ($6::text IS NULL OR e.account_id=$6) AND ($8::text IS NULL OR e.name=$8)
 AND ($9::timestamptz IS NULL OR (e.occurred_at,e.record_id)<($9,$10))`;
 const selection=person?`SELECT e.* FROM (
 SELECT $7::text AS id WHERE NOT EXISTS(SELECT 1 FROM metric_event_identities WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3 AND anonymous_id=$7)
 UNION SELECT anonymous_id FROM metric_event_identities WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3 AND user_id=$7
 ) actors CROSS JOIN LATERAL (
 SELECT e.* FROM metric_event_index e WHERE ${filters} AND e.user_id=actors.id ORDER BY e.occurred_at DESC,e.record_id DESC LIMIT $11
 ) e ORDER BY e.occurred_at DESC,e.record_id DESC LIMIT $11`:
 `SELECT e.* FROM metric_event_index e WHERE ${filters} AND $7::text IS NULL ORDER BY e.occurred_at DESC,e.record_id DESC LIMIT $11`;
 return `WITH selected AS MATERIALIZED (${selection})
 SELECT e.record_id AS "eventId",e.revision,e.occurred_at AS "occurredAt",r.received_at AS "receivedAt",e.name,${personSql} AS "userId",e.user_id AS "originalUserId",e.account_id AS "accountId",e.session_id AS "sessionId",r.payload->'original'->'record'->'data' AS data
 FROM selected e ${originalJoin} ${identityJoin} ORDER BY e.occurred_at DESC,e.record_id DESC`;
}
export async function eventTimeline(pool:pg.Pool,p:Principal,input:unknown){
 const b=object(input);return readTransaction(pool,async c=>{
 const s=await eventScope(c,p,b),limit=Number(b.limit??50);check(Number.isInteger(limit)&&limit>=1&&limit<=100,'Page size must be 1–100.');
 const after=b.after===undefined?null:object(b.after);const afterAt=after?instant(after.occurredAt):null,afterId=after?text(after.eventId,'Cursor event'):null;
 const filter=(key:string)=>b[key]===undefined||b[key]===''?null:text(b[key],key);
 const rows=(await c.query(eventTimelineSql(filter('userId')!==null),[s.sourceId,s.datasetKey,s.version,s.start,s.end,filter('accountId'),filter('userId'),filter('name'),afterAt,afterId,limit+1])).rows;
 const events=rows.slice(0,limit),last=events.at(-1);return {events,nextCursor:rows.length>limit?{occurredAt:last.occurredAt,eventId:last.eventId}:null,...s.metadata};
 });
}
export async function eventFunnel(pool:pg.Pool,p:Principal,input:unknown){
 const b=object(input),steps=funnelSteps(b.steps),unit=b.unit??'person',windowSeconds=Number(b.windowSeconds??86400);
 check(unit==='person'||unit==='account','Choose person or account.');check(Number.isInteger(windowSeconds)&&windowSeconds>=1&&windowSeconds<=90*86400,'Conversion window must be 1 second–90 days.');
 return readTransaction(pool,async c=>{
 const s=await eventScope(c,p,b);check(s.config.mapping[unit==='person'?'userId':'accountId'],'Dataset does not map this funnel identity.');
 const actorSql=unit==='person'?personSql:'e.account_id';
 const propertyKeys=[...new Set(steps.flatMap(step=>Object.keys(step.properties??{})))];
 const args=[s.sourceId,s.datasetKey,s.version,s.start,s.end,steps.map(s=>s.name),propertyKeys];
 const dataSource=s.config.mapping.properties?`r.payload->'original'->'record'->'data'->$8::text`:`r.payload->'original'->'record'->'data'`;
 if(s.config.mapping.properties&&propertyKeys.length)args.push(s.config.mapping.properties);
 const dataSql=propertyKeys.length?`(SELECT coalesce(jsonb_object_agg(k,(${dataSource})->k),'{}'::jsonb) FROM unnest($7::text[]) k WHERE (${dataSource}) ? k)`:`'{}'::jsonb`;
 const candidates=`SELECT e.record_id AS "eventId",e.occurred_at AS "occurredAt",e.name,${actorSql} AS actor,${dataSql} AS data
 FROM metric_event_index e ${originalJoin} ${identityJoin} WHERE ${baseWhere} AND e.name=ANY($6::text[]) AND ${actorSql} IS NOT NULL AND $7::text[] IS NOT NULL`;
 const budget=(await c.query(`SELECT count(*)::int count,coalesce(sum(octet_length(data::text)),0)::bigint bytes FROM (${candidates} LIMIT 50001) candidates`,args)).rows[0];
 check(budget.count<=50000,'Funnel exceeds 50,000 candidate events. Choose a shorter period.',422);
 check(Number(budget.bytes)<=16*1024*1024,'Funnel property data exceeds 16 MiB. Choose a shorter period.',422);
 const rows=(await c.query(`${candidates} ORDER BY e.occurred_at,e.record_id LIMIT 50000`,args)).rows;
 const result=evaluateFunnel(rows.map(r=>({...r,occurredAt:r.occurredAt.toISOString()})) as FunnelEvent[],steps,windowSeconds);
 const stage=Number(b.stage??1),outcome=b.outcome??'reached';check(Number.isInteger(stage)&&stage>=1&&stage<=steps.length,'Invalid funnel stage.');check(outcome==='reached'||outcome==='dropped','Choose reached or dropped.');
 const after=b.after===undefined?'':text(b.after,'Actor cursor'),participants=result.participants.filter(a=>(outcome==='reached'?a.reached>=stage:a.reached===stage)&&a.id>after);
 return {steps:result.steps,participants:participants.slice(0,50),nextCursor:participants.length>50?participants[49].id:null,totalParticipants:result.participants.filter(a=>outcome==='reached'?a.reached>=stage:a.reached===stage).length,unit,windowSeconds,candidateEvents:rows.length,...s.metadata};
 });
}
// Dataset retention is independent of metric retention; the raw original is shared.
export async function maintainEventRetention(c:SqlClient){
 await c.query(`DELETE FROM metric_event_index e USING (SELECT e.source_id,e.record_id FROM metric_event_index e JOIN metric_event_datasets d
 ON (e.source_id,e.dataset_key,e.schema_version)=(d.source_id,d.dataset_key,d.schema_version)
 WHERE e.occurred_at<now()-make_interval(days=>d.retention_days) LIMIT 10000) expired WHERE (e.source_id,e.record_id)=(expired.source_id,expired.record_id)`);
 // Event-only records also need expiry; keep compact hashes for retry deduplication.
 await c.query(`WITH expired AS (SELECT r.source_id,r.record_id,r.revision FROM metric_record_keys r
 JOIN metric_event_datasets d ON d.source_id=r.source_id AND d.dataset_key=r.payload->'original'->>'datasetKey' AND d.schema_version::text=r.payload->'original'->>'schemaVersion'
 WHERE r.processed AND d.backfilled AND r.payload ? 'original' AND jsonb_array_length(r.payload->'projections')=0
 AND NOT EXISTS(SELECT 1 FROM metric_event_index e WHERE e.source_id=r.source_id AND e.record_id=r.record_id)
 AND r.received_at<now()-make_interval(days=>d.retention_days) LIMIT 10000)
 UPDATE metric_record_keys r SET payload=(r.payload-'original')||'{"expired":true}'::jsonb FROM expired e WHERE (r.source_id,r.record_id,r.revision)=(e.source_id,e.record_id,e.revision)`);
}
export type {EventDataset};
