import {funnelCandidateSql,type FunnelQuery} from './funnel-candidates';
export {funnelCandidateSql,type FunnelQuery} from './funnel-candidates';
import {projectionFor} from './funnel-projections';
import type pg from 'pg';
import {createHash} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import {canonical,check,object,text} from '@/models/metrics/validation';
import {funnelSteps} from '@/models/metrics/events';
import {FunnelStream} from '@/models/metrics/funnel-stream';
import type {Principal} from '../access';
import {eventScope} from './events';
import {transaction} from '../db/metrics';

type Run={id:string;query_hash:string;source_id:string;query:FunnelQuery;owner_key:string;status:string;generation:string;erasure:string;counts:number[]|null;metadata:Record<string,unknown>|null;lease_token:string;completed_at:Date|null;started_at:Date|null;attempts:number;error:string|null;processed_events:string;projection_id:string|null;projection_revision:string|null};
export type FunnelRunResult={runId:string;status:string;steps:{name:string;count:number}[];participants:{id:string;reached:number}[];nextCursor:string|null;totalParticipants:number;unit:string;windowSeconds:number;recomputing:boolean;stale:boolean;skippedRecords:number;completedAt:string|null;asOf:string|null;error:string|null;processedEvents:number;projectionId?:string;projectionRevision?:string};
const owner=(p:Principal)=>`${p.kind}:${p.id}`;
async function generations(c:Pick<pg.Pool,'query'>,source:string){return (await c.query('SELECT generation::text,erasure::text FROM metric_event_generations WHERE source_id=$1',[source])).rows[0]??{generation:'0',erasure:'0'};}
async function normalize(c:pg.PoolClient,p:Principal,b:Record<string,unknown>){
 const s=await eventScope(c,p,b),steps=funnelSteps(b.steps),unit=b.unit??'person',windowSeconds=Number(b.windowSeconds??86400);
 check(unit==='person'||unit==='account','Choose person or account.');check(Number.isInteger(windowSeconds)&&windowSeconds>=1&&windowSeconds<=90*86400,'Conversion window must be 1 second–90 days.');
 check(s.config.mapping[unit==='person'?'userId':'accountId'],'Dataset does not map this funnel identity.');
 const q:FunnelQuery={sourceId:s.sourceId,datasetKey:s.datasetKey,schemaVersion:s.version,startsAt:s.start,endsAt:s.end,steps,unit,windowSeconds};return {q,s};
}
async function response(c:pg.PoolClient,p:Principal,r:Run,b:Record<string,unknown>):Promise<FunnelRunResult>{
 // Keep cleanup from deleting members between reading counts and paging them.
 check((await c.query('SELECT id FROM metric_funnel_runs WHERE id=$1 FOR SHARE',[r.id])).rowCount,'Funnel run expired. Request it again.',404);
 const s=await eventScope(c,p,r.query),g=await generations(c,r.source_id);
 const projection=await projectionFor(c,r.query);
 const expired=r.status==='completed'&&(r.erasure!==g.erasure||(r.projection_id&&(!projection||!projection.initialized||projection.dirty||projection.revision!==r.projection_revision)));
 let ready=r.status==='completed'&&!expired;
 const stage=Number(b.stage??1),outcome=b.outcome??'reached';check(Number.isInteger(stage)&&stage>=1&&stage<=r.query.steps.length,'Invalid funnel stage.');check(outcome==='reached'||outcome==='dropped','Choose reached or dropped.');
 const after=b.after===undefined?'':text(b.after,'Actor cursor');
 let rows:{id:string;reached:number}[]=[];
 if(ready&&r.projection_id){
  // The revision guard and participant page use ONE database statement snapshot.
  // This avoids copying all participants for every period, without mixing a
  // previously cached count with a concurrently updated sequence projection.
  const page=(await c.query(`SELECT coalesce(jsonb_agg(m ORDER BY m.id) FILTER(WHERE m.id IS NOT NULL),'[]'::jsonb) members
   FROM metric_funnel_definitions d
   LEFT JOIN LATERAL (SELECT actor AS id,max(stage)::int reached FROM metric_funnel_occurrences
    WHERE definition_id=d.id AND actor>$4 COLLATE "C" AND started_at>=$5 AND reached_at<$6
    GROUP BY actor HAVING max(stage)${outcome==='reached'?'>=':'='}$3 ORDER BY actor LIMIT 51) m ON true
   WHERE d.id=$1 AND d.revision=$2 AND NOT EXISTS(SELECT 1 FROM metric_funnel_dirty WHERE definition_id=d.id)
   AND NOT EXISTS(SELECT 1 FROM metric_event_generations WHERE source_id=d.source_id AND erasure<>$7)
   GROUP BY d.id`,[r.projection_id,r.projection_revision,stage,after,r.query.startsAt,r.query.endsAt,r.erasure])).rows[0];
  if(page)rows=page.members;else ready=false;
 }else if(ready)rows=(await c.query(`SELECT actor AS id,reached FROM metric_funnel_members WHERE run_id=$1 AND attempt=$2 AND reached${outcome==='reached'?'>=':'='}$3 AND actor>$4 COLLATE "C" ORDER BY actor LIMIT 51`,[r.id,r.lease_token,stage,after])).rows;
 const counts=ready?r.counts!:[];
 return {runId:r.id,status:r.status==='completed'&&!ready?'invalidated':r.status,steps:ready?r.query.steps.map((step,i)=>({name:step.name,count:counts[i]})):[],participants:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null,totalParticipants:ready?(outcome==='reached'?counts[stage-1]:counts[stage-1]-(counts[stage]??0)):0,unit:r.query.unit,windowSeconds:r.query.windowSeconds,recomputing:!ready||s.metadata.recomputing,stale:ready&&g.generation!==r.generation,skippedRecords:s.metadata.skippedRecords,completedAt:r.completed_at?.toISOString()??null,asOf:r.started_at?.toISOString()??null,error:!ready&&projection&&!projection.initialized?`Preprocessing retained events: ${projection.processed_events} scanned.${projection.error?' '+projection.error:''}`:r.error,processedEvents:Number(!ready&&projection&&!projection.initialized?projection.processed_events:r.processed_events),...(r.projection_id?{projectionId:r.projection_id,projectionRevision:r.projection_revision!}:{})};
}
export async function requestFunnelRun(pool:pg.Pool,p:Principal,input:unknown):Promise<FunnelRunResult>{
 const b=object(input);
 return transaction(pool,async c=>{
  const {q}=await normalize(c,p,b),projection=await projectionFor(c,q),hash=createHash('sha256').update(canonical({engine:2,...q,projectionId:projection?.id??null})).digest('hex');
  if(b.retry===true&&projection)await c.query('UPDATE metric_funnel_definitions SET attempts=0,error=NULL,available_at=now() WHERE id=$1 AND attempts>=3',[projection.id]);
  // A shared result is only returned after checking current dataset grants.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['funnel-request:'+hash]);
  const g=await generations(c,q.sourceId);
  let r=(await c.query(`SELECT * FROM metric_funnel_runs WHERE query_hash=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,[hash])).rows[0] as Run|undefined;
  if(!r&&(!projection||(!projection.dirty&&projection.initialized)))r=(await c.query(`SELECT * FROM metric_funnel_runs WHERE query_hash=$1 AND status='completed' AND erasure=$2 AND (generation=$3 OR completed_at>now()-interval '5 minutes') AND (projection_revision IS NOT DISTINCT FROM $4::bigint) ORDER BY completed_at DESC LIMIT 1`,[hash,g.erasure,g.generation,projection?.revision??null])).rows[0];
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
export async function processFunnelRun(pool:pg.Pool,options:{batchSize?:number;deadlineMs?:number;failAfterBatch?:boolean;afterBatch?:()=>Promise<void>}={}){
 const reader=await pool.connect();let locked=false,run:Run|undefined,inTransaction=false;
 const token=uuid(),batch=options.batchSize??5000,deadline=Date.now()+(options.deadlineMs??120000),began=performance.now();
 const timing={readMs:0,computeMs:0,writeMs:0,totalMs:0};
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
  const projection=await projectionFor(reader,run.query);
  if(projection&&(!projection.initialized||projection.dirty||projection.attempts>=3)){
   await reader.query('COMMIT');inTransaction=false;
   await pool.query(`UPDATE metric_funnel_runs SET status=$3,attempts=attempts-1,available_at=now()+interval '1 second',lease_until=NULL,error=$4 WHERE id=$1 AND lease_token=$2 AND status='running'`,[run.id,token,projection.attempts>=3?'failed':'queued',projection.attempts>=3?projection.error:'Preprocessing saved funnel sequences.']);
   return false;
  }
  if(projection){
   const t=performance.now();
   check(Date.now()<deadline,'Funnel exceeded its total processing budget.');
   const totals=(await reader.query(`WITH reached AS (
    SELECT actor,max(stage) reached FROM metric_funnel_occurrences WHERE definition_id=$1 AND started_at>=$2 AND reached_at<$3 GROUP BY actor
   ) SELECT ${run.query.steps.map((_,i)=>`count(*) FILTER(WHERE reached>=${i+1})::int AS stage${i}`).join(',')} FROM reached`,[projection.id,run.query.startsAt,run.query.endsAt])).rows[0];
   const counts=run.query.steps.map((_,i)=>totals['stage'+i]);
   await reader.query('COMMIT');inTransaction=false;
   await pool.query(`UPDATE metric_funnel_runs SET status='completed',counts=$3,metadata=$4,generation=$5,erasure=$6,projection_id=$7,projection_revision=$8,started_at=$9,completed_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`,[run.id,token,JSON.stringify(counts),{...s.metadata,engine:'projection',participants:counts[0],totalMs:performance.now()-t},g.generation,g.erasure,projection.id,projection.revision,projection.as_of]);
   return true;
  }
  const candidate=funnelCandidateSql(run.query,s.config.mapping);
  await reader.query('DECLARE warehouse_funnel_cursor NO SCROLL CURSOR FOR '+candidate.sql,candidate.args);
  const state=new FunnelStream(run.query.steps.length,run.query.windowSeconds*1000);
  let processed=0;
  const flush=async(members:{id:string;reached:number}[])=>{
   const t=performance.now();
   await transaction(pool,async c=>{
    const live=await c.query("UPDATE metric_funnel_runs SET processed_events=$3,lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",[run!.id,token,processed]);check(live.rowCount,'Funnel run cancelled.');
    if(members.length)await c.query(`INSERT INTO metric_funnel_members(run_id,attempt,actor,reached) SELECT $1,$2,id,reached FROM jsonb_to_recordset($3::jsonb) x(id text,reached smallint)`,[run!.id,token,JSON.stringify(members)]);
   });timing.writeMs+=performance.now()-t;
  };
  for(;;){
   check(Date.now()<deadline,'Funnel exceeded its total processing budget. Narrow the period or filters.');
   let t=performance.now();const result=await reader.query(`FETCH ${Math.max(1,Math.min(10000,Math.trunc(batch)))} FROM warehouse_funnel_cursor`);timing.readMs+=performance.now()-t;
   t=performance.now();const members=[];
   for(const e of result.rows){const member=state.push(e.actor,e.occurred_at.getTime(),e.mask);if(member)members.push(member);processed++;}timing.computeMs+=performance.now()-t;
   if(!result.rows.length){const member=state.finish();if(member)members.push(member);await flush(members);break;}
   await flush(members);await options.afterBatch?.();if(options.failAfterBatch)throw new Error('Injected funnel worker failure');
  }
  await reader.query('COMMIT');inTransaction=false;timing.totalMs=performance.now()-began;
  await pool.query(`UPDATE metric_funnel_runs SET status='completed',counts=$3,metadata=$4,generation=$5,erasure=$6,completed_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`,[run.id,token,JSON.stringify(state.counts),{...s.metadata,engine:'events',timing},g.generation,g.erasure]);
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
