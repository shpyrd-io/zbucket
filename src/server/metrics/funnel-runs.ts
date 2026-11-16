import type pg from 'pg';
import {createHash} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import {canonical,check,object,text} from '@/models/metrics/validation';
import {funnelSteps,type FunnelStep} from '@/models/metrics/events';
import {FunnelStream} from '@/models/metrics/funnel-stream';
import type {Principal} from '../access';
import {eventScope} from './events';
import {transaction} from '../db/metrics';

type Query={sourceId:string;datasetKey:string;schemaVersion:number;startsAt:string;endsAt:string;unit:'person'|'account';windowSeconds:number;steps:FunnelStep[]};
type Run={id:string;query_hash:string;source_id:string;query:Query;owner_key:string;status:string;generation:string;erasure:string;counts:number[]|null;metadata:Record<string,unknown>|null;lease_token:string;completed_at:Date|null;started_at:Date|null;attempts:number;error:string|null;processed_events:string};
export type FunnelRunResult={runId:string;status:string;steps:{name:string;count:number}[];participants:{id:string;reached:number}[];nextCursor:string|null;totalParticipants:number;unit:string;windowSeconds:number;recomputing:boolean;stale:boolean;skippedRecords:number;completedAt:string|null;asOf:string|null;error:string|null;processedEvents:number};
const owner=(p:Principal)=>`${p.kind}:${p.id}`;
async function generations(c:Pick<pg.Pool,'query'>,source:string){return (await c.query('SELECT generation::text,erasure::text FROM metric_event_generations WHERE source_id=$1',[source])).rows[0]??{generation:'0',erasure:'0'};}
async function normalize(c:pg.PoolClient,p:Principal,b:Record<string,unknown>){
 const s=await eventScope(c,p,b),steps=funnelSteps(b.steps),unit=b.unit??'person',windowSeconds=Number(b.windowSeconds??86400);
 check(unit==='person'||unit==='account','Choose person or account.');check(Number.isInteger(windowSeconds)&&windowSeconds>=1&&windowSeconds<=90*86400,'Conversion window must be 1 second–90 days.');
 check(s.config.mapping[unit==='person'?'userId':'accountId'],'Dataset does not map this funnel identity.');
 const q:Query={sourceId:s.sourceId,datasetKey:s.datasetKey,schemaVersion:s.version,startsAt:s.start,endsAt:s.end,steps,unit,windowSeconds};return {q,s};
}
async function response(c:pg.PoolClient,p:Principal,r:Run,b:Record<string,unknown>):Promise<FunnelRunResult>{
 // Keep cleanup from deleting members between reading counts and paging them.
 check((await c.query('SELECT id FROM metric_funnel_runs WHERE id=$1 FOR SHARE',[r.id])).rowCount,'Funnel run expired. Request it again.',404);
 const s=await eventScope(c,p,r.query),g=await generations(c,r.source_id);
 const expired=r.status==='completed'&&r.erasure!==g.erasure;
 const ready=r.status==='completed'&&!expired;
 const stage=Number(b.stage??1),outcome=b.outcome??'reached';check(Number.isInteger(stage)&&stage>=1&&stage<=r.query.steps.length,'Invalid funnel stage.');check(outcome==='reached'||outcome==='dropped','Choose reached or dropped.');
 const after=b.after===undefined?'':text(b.after,'Actor cursor');
 const rows=ready?(await c.query(`SELECT actor AS id,reached FROM metric_funnel_members WHERE run_id=$1 AND attempt=$2 AND reached${outcome==='reached'?'>=':'='}$3 AND actor>$4 COLLATE "C" ORDER BY actor LIMIT 51`,[r.id,r.lease_token,stage,after])).rows:[];
 const counts=ready?r.counts!:[];
 return {runId:r.id,status:expired?'invalidated':r.status,steps:ready?r.query.steps.map((step,i)=>({name:step.name,count:counts[i]})):[],participants:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null,totalParticipants:ready?(outcome==='reached'?counts[stage-1]:counts[stage-1]-(counts[stage]??0)):0,unit:r.query.unit,windowSeconds:r.query.windowSeconds,recomputing:!ready||s.metadata.recomputing,stale:ready&&g.generation!==r.generation,skippedRecords:s.metadata.skippedRecords,completedAt:r.completed_at?.toISOString()??null,asOf:r.started_at?.toISOString()??null,error:r.error,processedEvents:Number(r.processed_events)};
}
export async function requestFunnelRun(pool:pg.Pool,p:Principal,input:unknown):Promise<FunnelRunResult>{
 const b=object(input);
 return transaction(pool,async c=>{
  const {q}=await normalize(c,p,b),hash=createHash('sha256').update(canonical({engine:1,...q})).digest('hex');
  // A shared result is only returned after checking current dataset grants.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['funnel-request:'+hash]);
  const g=await generations(c,q.sourceId);
  let r=(await c.query(`SELECT * FROM metric_funnel_runs WHERE query_hash=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,[hash])).rows[0] as Run|undefined;
  if(!r)r=(await c.query(`SELECT * FROM metric_funnel_runs WHERE query_hash=$1 AND status='completed' AND erasure=$2 AND (generation=$3 OR completed_at>now()-interval '5 minutes') ORDER BY completed_at DESC LIMIT 1`,[hash,g.erasure,g.generation])).rows[0];
  if(!r){
   // Do not endlessly retry a permanently failed query on UI polling.
   const last=(await c.query(`SELECT * FROM metric_funnel_runs WHERE query_hash=$1 ORDER BY created_at DESC LIMIT 1`,[hash])).rows[0];
   if(last&&['failed','cancelled'].includes(last.status)&&b.retry!==true)r=last;
   else {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['funnel-admission:'+q.sourceId]);
    check(Number((await c.query("SELECT count(*) n FROM metric_funnel_runs WHERE source_id=$1 AND status IN ('queued','running')",[q.sourceId])).rows[0].n)<20,'Too many queued funnels for this source. Retry later.',429);
    r=(await c.query('INSERT INTO metric_funnel_runs(id,query_hash,source_id,query,owner_key) VALUES($1,$2,$3,$4,$5) RETURNING *',[uuid(),hash,q.sourceId,q,owner(p)])).rows[0];
   }
  }
  return response(c,p,r!,b);
 });
}
export async function readFunnelRun(pool:pg.Pool,p:Principal,id:string,input:unknown={}){
 return transaction(pool,async c=>{const r=(await c.query('SELECT * FROM metric_funnel_runs WHERE id=$1',[id])).rows[0];check(r,'Funnel run not found.',404);return response(c,p,r,object(input));});
}
export async function cancelFunnelRun(pool:pg.Pool,p:Principal,id:string){
 return transaction(pool,async c=>{const r=(await c.query('SELECT * FROM metric_funnel_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];check(r,'Funnel run not found.',404);await eventScope(c,p,r.query);check(r.owner_key===owner(p),'Only the requester can cancel this run.',403);await c.query("UPDATE metric_funnel_runs SET status='cancelled',lease_until=NULL WHERE id=$1 AND status IN ('queued','running')",[id]);return {cancelled:true};});
}
// Parameterized exact, typed filters. No raw-payload join without property filters.
export function funnelCandidateSql(q:Query,mapping:{properties?:string}){
 const args:unknown[]=[q.sourceId,q.datasetKey,q.schemaVersion,q.startsAt,q.endsAt,q.steps.map(s=>s.name)];
 const param=(v:unknown)=>{args.push(v);return '$'+args.length;};
 const hasProperties=q.steps.some(s=>Object.keys(s.properties??{}).length);
 const base=`r.payload->'original'->'record'->'data'`;
 const data=hasProperties&&mapping.properties?`(${base}->${param(mapping.properties)}::text)`:base;
 const mask=q.steps.map((s,i)=>`CASE WHEN e.name=${param(s.name)}::text${Object.entries(s.properties??{}).map(([k,v])=>` AND (${data}->${param(k)}::text)=${param(JSON.stringify(v))}::jsonb`).join('')} THEN ${1<<i} ELSE 0 END`).join(' + ');
 const actor=q.unit==='person'?'coalesce(identity.user_id,e.user_id)':'e.account_id';
 return {args,sql:`SELECT actor,occurred_at,mask FROM (SELECT ${actor} AS actor,e.occurred_at,e.record_id,(${mask})::int AS mask FROM metric_event_index e
 ${hasProperties?'JOIN metric_record_keys r ON (r.source_id,r.record_id,r.revision)=(e.source_id,e.record_id,e.revision)':''}
 ${q.unit==='person'?'LEFT JOIN metric_event_identities identity ON (identity.source_id,identity.dataset_key,identity.schema_version,identity.anonymous_id)=(e.source_id,e.dataset_key,e.schema_version,e.user_id)':''}
 WHERE e.source_id=$1 AND e.dataset_key=$2 AND e.schema_version=$3 AND e.occurred_at>=$4 AND e.occurred_at<$5 AND e.name=ANY($6::text[])) candidates
 WHERE actor IS NOT NULL AND mask<>0 ORDER BY actor COLLATE "C",occurred_at,record_id COLLATE "C"`};
}
export async function processFunnelRun(pool:pg.Pool,options:{batchSize?:number;deadlineMs?:number;failAfterBatch?:boolean;afterBatch?:()=>Promise<void>}={}){
 const reader=await pool.connect();let locked=false,run:Run|undefined,inTransaction=false;
 const token=uuid(),batch=options.batchSize??5000,deadline=Date.now()+(options.deadlineMs??120000);
 try{
  // Dedicated worker, one active calculation per schema. Never take ingestion locks.
  locked=(await reader.query("SELECT pg_try_advisory_lock(hashtext(current_schema()||':funnel-worker')) locked")).rows[0].locked;if(!locked)return false;
  run=await transaction(pool,async c=>{
   const r=(await c.query(`SELECT * FROM metric_funnel_runs WHERE (status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];if(!r)return undefined;
   return (await c.query(`UPDATE metric_funnel_runs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '3 minutes',started_at=clock_timestamp(),error=NULL,processed_events=0 WHERE id=$1 RETURNING *`,[r.id,token])).rows[0] as Run;
  });
  if(!run)return false;
  await pool.query('DELETE FROM metric_funnel_members WHERE run_id=$1',[run.id]);
  await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL work_mem='16MB'; SET LOCAL idle_in_transaction_session_timeout='30s'");inTransaction=true;
  const g=await generations(reader,run.source_id);
  const s=await eventScope(reader,{kind:'user',id:'worker',name:'Funnel worker',admin:false},run.query);
  const candidate=funnelCandidateSql(run.query,s.config.mapping);
  await reader.query('DECLARE warehouse_funnel_cursor NO SCROLL CURSOR FOR '+candidate.sql,candidate.args);
  const state=new FunnelStream(run.query.steps.length,run.query.windowSeconds*1000);
  let processed=0;
  const flush=async(members:{id:string;reached:number}[])=>{
   await transaction(pool,async c=>{
    const live=await c.query("UPDATE metric_funnel_runs SET processed_events=$3,lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",[run!.id,token,processed]);check(live.rowCount,'Funnel run cancelled.');
    if(members.length)await c.query(`INSERT INTO metric_funnel_members(run_id,attempt,actor,reached) SELECT $1,$2,id,reached FROM jsonb_to_recordset($3::jsonb) x(id text,reached smallint)`,[run!.id,token,JSON.stringify(members)]);
   });
  };
  for(;;){
   check(Date.now()<deadline,'Funnel exceeded its total processing budget. Narrow the period or filters.');
   const result=await reader.query(`FETCH ${Math.max(1,Math.min(10000,Math.trunc(batch)))} FROM warehouse_funnel_cursor`);
   const members=[];
   for(const e of result.rows){const member=state.push(e.actor,e.occurred_at.getTime(),e.mask);if(member)members.push(member);processed++;}
   if(!result.rows.length){const member=state.finish();if(member)members.push(member);await flush(members);break;}
   await flush(members);await options.afterBatch?.();if(options.failAfterBatch)throw new Error('Injected funnel worker failure');
  }
  await reader.query('COMMIT');inTransaction=false;
  await pool.query(`UPDATE metric_funnel_runs SET status='completed',counts=$3,metadata=$4,generation=$5,erasure=$6,completed_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`,[run.id,token,JSON.stringify(state.counts),s.metadata,g.generation,g.erasure]);
  return true;
 }catch(error){
  if(inTransaction){await reader.query('ROLLBACK');inTransaction=false;}
  if(run)await pool.query(`UPDATE metric_funnel_runs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,available_at=now()+interval '10 seconds'*attempts,lease_until=NULL,error=$3 WHERE id=$1 AND lease_token=$2 AND status='running'`,[run.id,token,error instanceof Error?error.message.slice(0,500):'Funnel processing failed']);
  if(options.failAfterBatch)throw error;
  return !!run;
 }finally{
  if(inTransaction)await reader.query('ROLLBACK');
  if(locked)await reader.query("SELECT pg_advisory_unlock(hashtext(current_schema()||':funnel-worker'))");reader.release();
 }
}
export async function cleanFunnelRuns(pool:pg.Pool){
 // Cached participants have a bounded lifetime, never an independent history store.
 await pool.query(`DELETE FROM metric_funnel_runs WHERE id IN (
  SELECT r.id FROM metric_funnel_runs r WHERE status NOT IN ('queued','running') AND (
   created_at<now()-interval '7 days' OR EXISTS(SELECT 1 FROM metric_event_generations g WHERE g.source_id=r.source_id AND g.erasure>r.erasure)
   OR EXISTS(SELECT 1 FROM metric_event_datasets d WHERE d.source_id=r.source_id AND d.dataset_key=r.query->>'datasetKey' AND d.schema_version=(r.query->>'schemaVersion')::int AND (r.query->>'startsAt')::timestamptz<now()-make_interval(days=>d.retention_days))) LIMIT 20)`);
}

export class FunnelProcessing extends Error {constructor(public result:FunnelRunResult){super(result.error??(result.status==='failed'?'Funnel failed. Retry from Event explorer.':`Funnel ${result.status}. Processing continues in the background.`));}}

export async function retryFunnelRun(pool:pg.Pool,p:Principal,id:string){
 const r=(await pool.query('SELECT query FROM metric_funnel_runs WHERE id=$1',[id])).rows[0];check(r,'Funnel run not found.',404);
 return requestFunnelRun(pool,p,{...r.query,retry:true});
}
