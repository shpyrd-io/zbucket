import type pg from 'pg';
import {createHash} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import {canonical,check} from '@/models/metrics/validation';
import type {SavedEventFunnel} from '@/models/metrics/library';
import {FunnelOccurrences} from '@/models/metrics/funnel-occurrences';
import {funnelCandidateSql,type FunnelQuery} from './funnel-candidates';

type DefinitionQuery=Omit<FunnelQuery,'startsAt'|'endsAt'>;
export function funnelDefinition(query:FunnelQuery){
 const {sourceId,datasetKey,schemaVersion,unit,windowSeconds,steps}=query;
 const definition:DefinitionQuery={sourceId,datasetKey,schemaVersion,unit,windowSeconds,steps};
 return {definition,hash:createHash('sha256').update(canonical({engine:1,...definition})).digest('hex')};
}
export async function subscribeFunnel(c:pg.PoolClient,libraryId:string,saved?:SavedEventFunnel){
 if(!saved){await c.query('DELETE FROM metric_funnel_subscriptions WHERE library_id=$1',[libraryId]);return;}
 const {definition:q,hash}=funnelDefinition(saved.query);
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['funnel-definitions:'+q.sourceId]);
 let d=(await c.query('SELECT id FROM metric_funnel_definitions WHERE definition_hash=$1',[hash])).rows[0];
 if(!d){
  // Registration barrier: finish any in-flight publication before the new
  // definition becomes visible. The lock covers registration, never backfill.
  await c.query('LOCK TABLE metric_event_index,metric_event_identities IN SHARE MODE');
  check(Number((await c.query('SELECT count(*) n FROM metric_funnel_definitions d WHERE source_id=$1 AND EXISTS(SELECT 1 FROM metric_funnel_subscriptions WHERE definition_id=d.id AND library_id<>$2)',[q.sourceId,libraryId])).rows[0].n)<20,'At most 20 distinct preprocessed funnels per source. Remove unused saved funnels first.',429);
  d=(await c.query(`INSERT INTO metric_funnel_definitions(id,definition_hash,source_id,dataset_key,schema_version,unit,query,names) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[uuid(),hash,q.sourceId,q.datasetKey,q.schemaVersion,q.unit,q,q.steps.map(s=>s.name)])).rows[0];
 }
 await c.query('INSERT INTO metric_funnel_subscriptions(library_id,definition_id) VALUES($1,$2) ON CONFLICT(library_id) DO UPDATE SET definition_id=EXCLUDED.definition_id',[libraryId,d.id]);
}
export async function projectionFor(c:Pick<pg.PoolClient,'query'>,q:FunnelQuery){
 return (await c.query(`SELECT d.*,EXISTS(SELECT 1 FROM metric_funnel_dirty WHERE definition_id=d.id) dirty FROM metric_funnel_definitions d WHERE definition_hash=$1 AND (SELECT enabled FROM metric_funnel_preprocessing WHERE id) AND EXISTS(SELECT 1 FROM metric_funnel_subscriptions WHERE definition_id=d.id)`,[funnelDefinition(q).hash])).rows[0];
}
/** Bootstrap old library items; save/delete update subscriptions transactionally. */
export async function reconcileFunnelSubscriptions(pool:pg.Pool){
 const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('metric-library'))");
  const rows=(await c.query(`SELECT id,config FROM metric_library m WHERE config ? 'eventFunnel' AND NOT EXISTS(SELECT 1 FROM metric_funnel_subscriptions WHERE library_id=m.id) ORDER BY updated_at LIMIT 1000`)).rows;
  let registered=0;
  for(const row of rows){
   await c.query('SAVEPOINT register_funnel');
   try{await subscribeFunnel(c,row.id,row.config.eventFunnel);registered++;}
   catch(error){await c.query('ROLLBACK TO SAVEPOINT register_funnel');console.error('Saved funnel registration:',error instanceof Error?error.message:'Unavailable definition');}
   await c.query('RELEASE SAVEPOINT register_funnel');if(registered>=20)break;
  }
  await c.query(`DELETE FROM metric_funnel_definitions d WHERE NOT EXISTS(SELECT 1 FROM metric_funnel_subscriptions WHERE definition_id=d.id)`);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
/** One schema-wide worker; reader snapshot and atomic writer publication.
 * Queue versions are acknowledged in READ COMMITTED, never by locking ingestion
 * rows for the duration of a rebuild. Concurrent changes remain queued.
 */
export async function processFunnelProjection(pool:pg.Pool,options:{backfillBatch?:number;actorBatch?:number;deadlineMs?:number;afterRead?:()=>Promise<void>;failBeforeCommit?:boolean}={}){
 const reader=await pool.connect();let writer:pg.PoolClient|undefined,locked=false,reading=false,writing=false,d:Record<string,any>|undefined;
 const begin=performance.now(),timing={readMs:0,computeMs:0,writeMs:0,events:0,occurrences:0,actors:0,totalMs:0};
 try{
  locked=(await reader.query("SELECT pg_try_advisory_lock(hashtext(current_schema()||':funnel-projections')) locked")).rows[0].locked;if(!locked)return false;
  await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL work_mem='16MB'; SET LOCAL cursor_tuple_fraction=1; SET LOCAL idle_in_transaction_session_timeout='30s'");reading=true;
  d=(await reader.query(`SELECT d.*,s.mapping,s.retention_days FROM metric_funnel_definitions d JOIN metric_event_datasets s USING(source_id,dataset_key,schema_version)
   WHERE (SELECT enabled FROM metric_funnel_preprocessing WHERE id) AND d.attempts<3 AND d.available_at<=now() AND EXISTS(SELECT 1 FROM metric_funnel_subscriptions WHERE definition_id=d.id)
   AND (NOT d.initialized OR EXISTS(SELECT 1 FROM metric_funnel_dirty WHERE definition_id=d.id))
   ORDER BY d.available_at,d.created_at LIMIT 1`)).rows[0];
  if(!d)return false;
  const dirty=d.initialized?(await reader.query('SELECT actor,version::text FROM metric_funnel_dirty WHERE definition_id=$1 ORDER BY actor LIMIT $2',[d.id,Math.max(1,Math.min(options.actorBatch??500,5000))])).rows:[];
  const backfill=!d.initialized;
  let cursor:string|null=d.backfill_cursor,finished=false;
  let actors:string[]=dirty.map((r:{actor:string})=>r.actor);
  if(backfill){
   // Walk the existing identity index before loading histories. Its native
   // collation is used for both keyset predicates and ordering. Canonical
   // aliases can span batches; rebuilding each complete canonical history is
   // idempotent, and the dirty queue catches changes behind the checkpoint.
   const field=d.unit==='person'?'user_id':'account_id';
   const ids=(await reader.query(`SELECT DISTINCT ${field} actor FROM metric_event_index
    WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3 AND ${field} IS NOT NULL
    ${cursor!==null?`AND ${field}>$5`:''} ORDER BY ${field} LIMIT $4`,
    [d.source_id,d.dataset_key,d.schema_version,Math.max(1,Math.min(options.backfillBatch??5000,10000)),...(cursor!==null?[cursor]:[])])).rows.map(r=>r.actor);
   finished=ids.length===0;cursor=ids.at(-1)??cursor;actors=ids;
   if(d.unit==='person'&&ids.length)actors=(await reader.query(`SELECT DISTINCT coalesce(i.user_id,a.id) actor FROM unnest($4::text[]) a(id)
    LEFT JOIN metric_event_identities i ON i.source_id=$1 AND i.dataset_key=$2 AND i.schema_version=$3 AND i.anonymous_id=a.id`,[d.source_id,d.dataset_key,d.schema_version,ids])).rows.map(r=>r.actor);
  }
  const q={...d.query,startsAt:new Date(Date.now()-d.retention_days*86400000).toISOString(),endsAt:'9999-01-01T00:00:00.000Z'} as FunnelQuery;
  const snapshot=(await reader.query('SELECT clock_timestamp() at')).rows[0].at;
  check(performance.now()-begin<(options.deadlineMs??120000),'Funnel preprocessing exceeded its processing budget.');
  const candidate=funnelCandidateSql(q,d.mapping,actors);
  await reader.query('DECLARE projection_cursor NO SCROLL CURSOR FOR '+candidate.sql,candidate.args);
  writer=await pool.connect();await writer.query("BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='60s'");writing=true;
  let t=performance.now();
  await writer.query('DELETE FROM metric_funnel_occurrences WHERE definition_id=$1 AND actor=ANY($2::text[])',[d.id,actors]);timing.writeMs+=performance.now()-t;
  const state=new FunnelOccurrences(q.steps.length,q.windowSeconds*1000);let lastActor:string|undefined,lastProgress=0;
  for(;;){
   check(performance.now()-begin<(options.deadlineMs??120000),'Funnel preprocessing exceeded its processing budget.');
   t=performance.now();const rows=(await reader.query('FETCH 5000 FROM projection_cursor')).rows;timing.readMs+=performance.now()-t;
   if(!rows.length)break;
   t=performance.now();const occurrences=[];
   for(const e of rows){if(e.actor!==lastActor){timing.actors++;lastActor=e.actor;}occurrences.push(...state.push(e.actor,e.occurred_at.getTime(),e.mask));}
   timing.computeMs+=performance.now()-t;timing.events+=rows.length;timing.occurrences+=occurrences.length;
   t=performance.now();if(occurrences.length)await writer.query(`INSERT INTO metric_funnel_occurrences(definition_id,actor,stage,started_at,reached_at,build_generation) SELECT $1,actor,stage,"startedAt","reachedAt",$3 FROM jsonb_to_recordset($2) x(actor text,stage smallint,"startedAt" timestamptz,"reachedAt" timestamptz)`,[d.id,JSON.stringify(occurrences),d.build_generation]);timing.writeMs+=performance.now()-t;
   if(performance.now()-lastProgress>1000){await pool.query('UPDATE metric_funnel_definitions SET processed_events=$2 WHERE id=$1',[d.id,(backfill?Number(d.stats?.events??0):0)+timing.events]);lastProgress=performance.now();}
  }
  await options.afterRead?.();
  await reader.query('COMMIT');reading=false;
  // Conditional ACK: changes after the snapshot keep their newer queue version.
  if(dirty.length)await writer.query(`DELETE FROM metric_funnel_dirty q USING jsonb_to_recordset($2) a(actor text,version bigint) WHERE q.definition_id=$1 AND q.actor=a.actor AND q.version=a.version`,[d.id,JSON.stringify(dirty)]);
  timing.totalMs=performance.now()-begin;
  const prior=backfill&&d.backfill_cursor!==null?d.stats:null;
  const stats={...timing,mode:backfill?'backfill':'incremental',queuedActors:dirty.length,batches:1};
  if(prior)for(const key of ['readMs','computeMs','writeMs','events','occurrences','actors','totalMs','batches'] as const)stats[key]+=Number(prior[key]??0);
  await writer.query(`UPDATE metric_funnel_definitions SET initialized=$5,revision=revision+1,updated_at=clock_timestamp(),as_of=$2,attempts=0,error=NULL,available_at=clock_timestamp(),stats=$3,processed_events=$4,
   backfill_cursor=$6,backfill_started_at=coalesce(backfill_started_at,$2) WHERE id=$1`,
   [d.id,snapshot,stats,stats.events,!backfill||finished,cursor]);
  if(options.failBeforeCommit)throw new Error('Injected projection publication failure');
  await writer.query('COMMIT');writing=false;return true;
 }catch(error){
  if(reading){await reader.query('ROLLBACK');reading=false;}
  if(writing){await writer!.query('ROLLBACK');writing=false;}
  if(d)await reader.query(`UPDATE metric_funnel_definitions SET processed_events=$3,attempts=attempts+1,error=$2,available_at=now()+interval '10 seconds'*(attempts+1) WHERE id=$1`,[d.id,error instanceof Error?error.message.slice(0,500):'Preprocessing failed',d.stats?.events??0]);
  if(options.failBeforeCommit)throw error;
  return !!d;
 }finally{
  if(reading)await reader.query('ROLLBACK');if(writing)await writer!.query('ROLLBACK');writer?.release();
  if(locked)await reader.query("SELECT pg_advisory_unlock(hashtext(current_schema()||':funnel-projections'))");reader.release();
 }
}
export async function cleanFunnelProjections(pool:pg.Pool){
 // Bound retention cleanup; period reads also apply current retention immediately.
 await pool.query(`DELETE FROM metric_funnel_occurrences o USING (SELECT o.ctid FROM metric_funnel_occurrences o JOIN metric_funnel_definitions d ON d.id=o.definition_id JOIN metric_event_datasets s USING(source_id,dataset_key,schema_version) WHERE (o.build_generation<>d.build_generation OR o.started_at<now()-make_interval(days=>s.retention_days)) LIMIT 10000) expired WHERE o.ctid=expired.ctid`);
}

/** Operational rollback switch. Re-enabling always rebuilds retained history:
 * events received while disabled were deliberately not enqueued. */
export async function setFunnelPreprocessing(pool:pg.Pool,enabled:boolean){
 const c=await pool.connect();try{await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()||':funnel-projections'))");
  await c.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()||':funnel-worker'))");
  const old=(await c.query('SELECT enabled FROM metric_funnel_preprocessing WHERE id FOR UPDATE')).rows[0].enabled;
  await c.query('UPDATE metric_funnel_preprocessing SET enabled=$1 WHERE id',[enabled]);
  if(enabled&&!old)await c.query('LOCK TABLE metric_event_index,metric_event_identities IN SHARE MODE');
  if(enabled&&!old)await c.query('UPDATE metric_funnel_definitions SET initialized=false,revision=revision+1,build_generation=build_generation+1,backfill_cursor=NULL,backfill_started_at=NULL,stats=NULL,attempts=0,error=NULL,available_at=now(),processed_events=0');
  await c.query('COMMIT');return {enabled,rebuild:enabled&&!old};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
