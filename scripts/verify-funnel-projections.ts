import pg from 'pg';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Local PostgreSQL only.');
const schema='funnel_projections_'+Date.now(),root=new pg.Pool({connectionString:url.toString(),max:2});await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.ZBUCKET_ACCESS='local';delete process.env.VOYAGE_API_KEY;
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');const {processFunnelRun}=await import('../src/server/metrics/funnel-runs');
const {processFunnelProjection,reconcileFunnelSubscriptions,cleanFunnelProjections,setFunnelPreprocessing}=await import('../src/server/metrics/funnel-projections');const {prewarmFunnels}=await import('../src/server/metrics/funnel-prewarming');
let pool:pg.Pool|undefined;const checks:string[]=[],report:Record<string,any>={at:new Date().toISOString(),scope:'Isolated local PostgreSQL; real API ingestion for correctness and incremental updates, synthetic published index fixture for load. No production capacity claim.'};
async function call(path:string,body?:unknown,token?:string,status=200){const r=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('/')})});const value=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(value)}`);return value;}
async function drain(){for(let i=0;i<10000;i++){const worked=await processFunnelProjection(pool!);if(!worked)break;if(i&&i%20===0)console.log('Preprocessing batches:',i);if(i===9999)throw new Error('Projection did not drain');}const failed=(await pool!.query('SELECT error FROM metric_funnel_definitions WHERE error IS NOT NULL')).rows;assert.deepEqual(failed,[]);await pool!.query("UPDATE metric_funnel_runs SET available_at=now() WHERE status='queued'");while(await processFunnelRun(pool!)){} }
const counts=(r:any)=>r.steps.map((s:any)=>s.count);
try{
 await call('session');pool=await database();
 const grants={metrics:{read:[],write:[],eventRead:['app','load'],eventWrite:['app','load'],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
 const app=await call('integrations',{action:'create',name:'Projection acceptance',permissions:grants}),token=(await call('integrations',{action:'issue',id:app.id})).secret;
 const sourceId=(await call('integrations')).apps.find((a:any)=>a.id===app.id).source_id;
 for(const key of ['app','load']){await call('metrics/datasets',{sourceId,key,schema:{name:'string',person:'string',account:'string',properties:'properties'}});await call('metrics/event-datasets',{sourceId,datasetKey:key,schemaVersion:1,mapping:{name:'name',userId:'person',accountId:'account',properties:'properties'},retentionDays:30});}
 const base=new Date(Date.now()-10*86400000);base.setUTCHours(0,0,0,0);const at=(d:number)=>new Date(+base+d*86400000).toISOString();
 const q={sourceId,datasetKey:'app',schemaVersion:1,startsAt:at(0),endsAt:at(9),unit:'person',windowSeconds:86400,steps:[{name:'open'},{name:'export',properties:{paid:true}}]};
 const event=(id:string,name:string,day:number,person:string,paid:unknown=true,account='acme')=>({eventId:id,occurredAt:at(day),data:{name,person,account,properties:{paid}}});
 const ingest=async(events:unknown[],datasetKey='app')=>{await call('metrics/events',{datasetKey,schemaVersion:1,events},token,202);while(await processMetricBatch(pool!)){} };
 await ingest([event('a','open',.1,'user:a'),event('b','export',1.1,'user:a'),event('c','open',2,'user:a'),event('d','export',2.1,'user:a'),event('e','open',2,'user:b'),event('f','export',2.1,'user:b','true')]);
 const direct=await call('metrics/event-funnel',q,token);
 const save=async(query:typeof q,name='Saved projection')=>call('metrics/library',{name,kind:'query',visibility:'private',config:{eventFunnel:{query,period:'fixed',compare:'none'},chart:{kind:'funnel'}}});
 // Register while an index publication is still uncommitted. The short table
 // barrier makes the historical snapshot include that publication.
 const inflight=await pool.connect();await inflight.query('BEGIN');await inflight.query("UPDATE metric_event_index SET name=name WHERE source_id=$1 AND record_id='a'",[sourceId]);
 const saving=save(q);let blocked=false;
 try{for(let i=0;i<100;i++){
  blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='metric_event_index'::regclass AND mode='ShareLock' AND NOT granted) blocked")).rows[0].blocked;
  if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
 }}finally{await inflight.query('COMMIT');inflight.release();}
 assert.equal(blocked,true,'Registration must wait for in-flight event publication');
 const saved=await saving,copy=await save({...q,startsAt:at(1)},'Another period');assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_definitions')).rows[0].n,1);
 const queued=await call('metrics/event-funnel-runs',q,token);assert.equal(queued.status,'queued');await drain();
 const done=await call('metrics/event-funnel-runs/'+queued.runId,{},token);assert.deepEqual(counts(done),counts(direct));assert.ok(done.projectionId);
 for(const [from,to] of [[0,1],[1,2],[0,2],[2,3],[2.05,3],[0,9]]){
  const query={...q,startsAt:at(from),endsAt:at(to)},expected=await call('metrics/event-funnel',query,token),run=await call('metrics/event-funnel-runs',query,token);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+run.runId,{},token)),counts(expected));
 }
 checks.push('Historical fill, shared definitions independent of period, cross-day and repeated attempts exactly match direct engine');
 // New conversion affects only b; an irrelevant event must not enter the queue.
 await ingest([event('g','export',2.2,'user:b'),event('unrelated','unrelated',2.3,'user:other')]);
 assert.deepEqual((await pool.query('SELECT actor FROM metric_funnel_dirty ORDER BY actor')).rows.map(r=>r.actor),['user:b']);
 assert.equal((await call('metrics/event-funnel-runs/'+done.runId,{},token)).status,'invalidated');
 const rev=(await pool.query('SELECT revision FROM metric_funnel_definitions')).rows[0].revision;
 await assert.rejects(()=>processFunnelProjection(pool!,{failBeforeCommit:true}));assert.equal((await pool.query('SELECT revision FROM metric_funnel_definitions')).rows[0].revision,rev);assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_dirty')).rows[0].n,1);
 await pool.query('UPDATE metric_funnel_definitions SET available_at=now()');await drain();
 assert.equal((await pool.query('SELECT stats FROM metric_funnel_definitions')).rows[0].stats.queuedActors,1);
 checks.push('Only affected actors are rebuilt; failed publication rolls back atomically and retries without double counting');
 // A concurrent new event survives conditional queue acknowledgement.
 await ingest([event('h','open',4,'user:c')]);
 await processFunnelProjection(pool,{afterRead:async()=>{await ingest([event('i','export',4.1,'user:c')]);}});
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_dirty')).rows[0].n,1);await drain();
 const current=await call('metrics/event-funnel-runs',q,token);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+current.runId,{},token)),[3,3]);
 checks.push('Concurrent ingestion during preprocessing remains queued and converges to the exact result');
 await call('metrics/corrections',{mode:'events',recordId:'g',revision:2,tombstone:true,reason:'Correction acceptance'},token,202);while(await processMetricBatch(pool)){}await drain();
 const corrected=await call('metrics/event-funnel-runs',q,token);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+corrected.runId,{},token)),[3,2]);
 // Anonymous identities merge; accounts keep their event-time values.
 const anon='anon:11111111-1111-4111-8111-111111111111';await ingest([event('anon-open','open',5,anon,true,'before'),event('linked-export','export',5.1,'user:linked',true,'after')]);await drain();
 await call('metrics/event-identify',{datasetKey:'app',schemaVersion:1,anonymousId:anon,userId:'user:linked'},token);await drain();
 const linked=await call('metrics/event-funnel-runs',q,token);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+linked.runId,{},token)),[4,3]);
 const accountQ={...q,unit:'account'};await save(accountQ);const accountRun=await call('metrics/event-funnel-runs',accountQ,token);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+accountRun.runId,{},token)),counts(await call('metrics/event-funnel',accountQ,token)));
 checks.push('Corrections and anonymous linking rebuild exact sequences; account identity stays at event time');
 // Revisions preserve the previous definition while another report references it.
 await call('metrics/library/'+saved.id,{name:saved.name,kind:'query',visibility:'private',revision:saved.revision,config:{eventFunnel:{query:{...q,windowSeconds:3600},period:'fixed'},chart:{kind:'funnel'}}});await drain();assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_definitions')).rows[0].n,3);
 await prewarmFunnels(pool);await drain();const dashboard=await call('metrics/library-run',{id:copy.id});assert.ok(dashboard.panels[0].data);
 const info=(await call('integrations')).apps.find((a:any)=>a.id===app.id);await call('integrations',{action:'update',id:app.id,revision:info.revision,name:info.name,permissions:{...grants,metrics:{...grants.metrics,eventRead:[]}}});await call('metrics/event-funnel-runs/'+linked.runId,{},token,403);
 const denied=(await call('integrations')).apps.find((a:any)=>a.id===app.id);await call('integrations',{action:'update',id:app.id,revision:denied.revision,name:denied.name,permissions:grants});
 checks.push('Definition revisions, proactive saved-period warming and permission checks on cached participants');
 // A permanently failing backfill stops after three attempts and explicit retry recovers.
 const fq={...q,windowSeconds:86402};await save(fq,'Retry acceptance');const failedRun=await call('metrics/event-funnel-runs',fq);
 for(let i=0;i<3;i++){await processFunnelProjection(pool,{deadlineMs:0});await pool.query('UPDATE metric_funnel_definitions SET available_at=now() WHERE NOT initialized');}
 await processFunnelRun(pool);assert.equal((await call('metrics/event-funnel-runs/'+failedRun.runId,{})).status,'failed');
 const recovery=await call('metrics/event-funnel-runs/'+failedRun.runId,{action:'retry'});await drain();assert.equal((await call('metrics/event-funnel-runs/'+recovery.runId,{})).status,'completed');
 // Disable is a real fallback; changes while disabled must be included on rebuild.
 await setFunnelPreprocessing(pool,false);await ingest([event('disabled-open','open',6,'user:disabled'),event('disabled-export','export',6.1,'user:disabled')]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_dirty')).rows[0].n,0);
 const fallback=await call('metrics/event-funnel-runs',q);await drain();assert.equal((await call('metrics/event-funnel-runs/'+fallback.runId,{})).projectionId,undefined);
 await setFunnelPreprocessing(pool,true);await drain();const resumed=await call('metrics/event-funnel-runs',q);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+resumed.runId,{})),counts(await call('metrics/event-funnel',q)));
 // Clean projections beyond retention without granting historical access.
 await pool.query("INSERT INTO metric_funnel_occurrences SELECT id,'expired',1,now()-interval '40 days',now()-interval '40 days' FROM metric_funnel_definitions");
 await cleanFunnelProjections(pool);assert.equal((await pool.query("SELECT count(*)::int n FROM metric_funnel_occurrences WHERE actor='expired'")).rows[0].n,0);
 await call('metrics/event-funnel-runs',{...q,startsAt:new Date(Date.now()-40*86400000).toISOString()},token,422);
 checks.push('Three-attempt failure limit, explicit retry, operational disable/enable rebuild and retained-history cleanup');
 await reconcileFunnelSubscriptions(pool);
 // Initial batches commit checkpoints but never expose a partial report.
 const rq={...q,windowSeconds:86407,steps:[{name:'resume-open'},{name:'resume-export'}]};
 const resumeAnon='anon:22222222-2222-4222-8222-222222222222';
 await ingest([event('resume-a','resume-open',5,'!resume-a'),event('resume-anon','resume-open',5,resumeAnon),event('resume-linked','resume-export',5.1,'user:zzresume')]);
 const resumeSaved=await save(rq,'Resumable acceptance'),resumeRun=await call('metrics/event-funnel-runs',rq);
 const resumeDef=(await pool.query('SELECT definition_id id FROM metric_funnel_subscriptions WHERE library_id=$1',[resumeSaved.id])).rows[0].id;
 await processFunnelProjection(pool,{backfillBatch:1});
 const checkpoint=(await pool.query('SELECT backfill_cursor,processed_events FROM metric_funnel_definitions WHERE id=$1',[resumeDef])).rows[0];
 assert.equal(checkpoint.backfill_cursor,'!resume-a');
 assert.equal((await call('metrics/event-funnel-runs/'+resumeRun.runId,{})).steps.length,0);
 await assert.rejects(()=>processFunnelProjection(pool!,{backfillBatch:1,failBeforeCommit:true}));
 assert.deepEqual((await pool.query('SELECT backfill_cursor,processed_events FROM metric_funnel_definitions WHERE id=$1',[resumeDef])).rows[0],checkpoint);
 await pool.query('UPDATE metric_funnel_definitions SET available_at=now() WHERE id=$1',[resumeDef]);
 await ingest([event('resume-a-export','resume-export',5.1,'!resume-a'),event('resume-behind-open','resume-open',5,'!0:behind'),event('resume-behind-export','resume-export',5.1,'!0:behind')]);
 await call('metrics/event-identify',{datasetKey:'app',schemaVersion:1,anonymousId:resumeAnon,userId:'user:zzresume'},token);
 await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+resumeRun.runId,{})),[3,3]);
 await setFunnelPreprocessing(pool,false);
 for(const recordId of ['resume-behind-open','resume-behind-export'])await call('metrics/corrections',{mode:'events',recordId,revision:2,tombstone:true,reason:'Rebuild generation acceptance'},token,202);
 while(await processMetricBatch(pool)){}await setFunnelPreprocessing(pool,true);await drain();
 const rebuilt=await call('metrics/event-funnel-runs',rq);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+rebuilt.runId,{})),[2,2]);
 checks.push('Backfill resumes after rollback; writes behind its checkpoint and aliases spanning batches converge; rebuild generations exclude removed actors');
 // The same event name can have filtered and unfiltered steps, without a UNION duplicate.
 await ingest([event('mixed-a','mixed',7,'mixed:a'),event('mixed-b1','mixed',7,'mixed:b',false),event('mixed-b2','mixed',7.1,'mixed:b',true)]);
 const mq={...q,steps:[{name:'mixed',properties:{paid:true}},{name:'mixed'}]};
 const mixed=await call('metrics/event-funnel-runs',mq);await drain();assert.deepEqual(counts(await call('metrics/event-funnel-runs/'+mixed.runId,{})),[2,0]);
 checks.push('Mixed filtered and unfiltered repeated steps do not reuse a single event occurrence');
 if(process.argv.includes('--load')){
  assert(/^[a-z0-9-]{0,40}$/.test(process.env.FUNNEL_LOAD_LABEL??''),'Invalid report label');
  const count=Number(process.env.FUNNEL_LOAD_PEOPLE??150000);assert(Number.isInteger(count)&&count>=400&&count<=1000000&&count%4===0);
  console.log('Building isolated load fixture for',count,'participants');const fixtureStart=performance.now();
  const c=await pool.connect();try{
   await c.query("BEGIN; SET LOCAL statement_timeout='180s'");
   const receipt=(await c.query("INSERT INTO metric_ingestions(id,source_id,status,record_count,payload_hash) VALUES(gen_random_uuid(),$1,'completed',0,'synthetic') RETURNING id",[sourceId])).rows[0].id;
   await c.query('COMMIT');
   // Bound fixture-building statements independently of the unchanged worker budgets.
   for(let first=1;first<=count;first+=100000){
   const last=Math.min(first+99999,count);await c.query("BEGIN; SET LOCAL statement_timeout='180s'");
   await c.query(`CREATE TEMP TABLE generated ON COMMIT DROP AS SELECT g::text actor,(g::bigint*10+s)::text id,($2::timestamptz+(g%7)*interval '1 day'+s*interval '1 second') at,(ARRAY['open','signup','use','export'])[s] name FROM generate_series($3::int,$1::int) g CROSS JOIN generate_series(1,4) s WHERE s<=1+g%4`,[last,at(2),first]);
   await c.query(`INSERT INTO generated SELECT g::text,(g::bigint*10)::text,$2::timestamptz+(g%7)*interval '1 day','open' FROM generate_series($3::int,$1::int) g`,[last,at(0),first]);
   await c.query(`INSERT INTO metric_record_keys(source_id,record_id,revision,hash,ingestion_id,payload,processed) SELECT $1,'load-'||id,1,'synthetic',$2,jsonb_build_object('projections','[]'::jsonb,'original',jsonb_build_object('mode','events','datasetKey','load','schemaVersion',1,'record',jsonb_build_object('occurredAt',at,'data',jsonb_build_object('name',name,'person','user:'||actor,'account','group:'||actor,'properties',jsonb_build_object('paid',true))))),true FROM generated`,[sourceId,receipt]);
   await c.query(`INSERT INTO metric_event_index SELECT $1,'load-'||id,1,'load',1,at,name,'user:'||actor,'group:'||actor,NULL FROM generated`,[sourceId]);await c.query('COMMIT');
   console.log('Fixture participants:',last,'/',count,'elapsed seconds:',Math.round((performance.now()-fixtureStart)/1000));
   }
   await c.query('ANALYZE metric_event_index');await c.query('ANALYZE metric_record_keys');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  report.fixtureMs=performance.now()-fixtureStart;
  const lq={...q,datasetKey:'load',startsAt:at(0),endsAt:at(10),steps:[{name:'open'},{name:'signup'},{name:'use'},{name:'export',properties:{paid:true}}]};
  const timedRun=async(query:typeof lq)=>{const pending=await call('metrics/event-funnel-runs',query);const start=performance.now();await drain();const done=await call('metrics/event-funnel-runs/'+pending.runId,{});assert.equal(done.status,'completed',JSON.stringify(done));return {ms:performance.now()-start,done,metadata:(await pool!.query('SELECT metadata FROM metric_funnel_runs WHERE id=$1',[done.runId])).rows[0].metadata};};
  const expectedCounts=[count,count*.75,count*.5,count*.25];
  const load:Record<string,any>=report.load={participants:count,events:count*3.5};
  const baselineRun=async(query:typeof lq)=>{
   const start=performance.now();try{const r=await timedRun(query);assert.deepEqual(counts(r.done),expectedCounts);return {ms:r.ms,metadata:r.metadata};}
   catch(error){const failed=await call('metrics/event-funnel-runs',query);await call('metrics/event-funnel-runs/'+failed.runId,{action:'cancel'});const failure={ms:performance.now()-start,status:failed.status,error:error instanceof Error?error.message:String(error)};console.log('Direct engine did not complete:',failure);return failure;}
  };
  console.log('Measuring direct engine');load.baseline=await baselineRun(lq);
  load.warmBaseline=await baselineRun({...lq,windowSeconds:lq.windowSeconds+1});
  load.rawCachedReadMs=[];for(let i=0;i<10;i++){const t=performance.now();await call('metrics/event-funnel-runs',lq);load.rawCachedReadMs.push(performance.now()-t);}
  load.rawSnapshotStorageBytes=(await pool.query("SELECT pg_total_relation_size('metric_funnel_member_blocks')::text bytes")).rows[0].bytes;
  const candidate=(await import('../src/server/metrics/funnel-candidates')).funnelCandidateSql({...lq,unit:'person'},{properties:'properties'});
  const explain=await pool.connect();try{
   await explain.query("BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL work_mem='16MB'; SET LOCAL cursor_tuple_fraction=1; SET LOCAL max_parallel_workers_per_gather=0");
   load.cursorPlan=(await explain.query('EXPLAIN (FORMAT JSON) DECLARE probe_cursor NO SCROLL CURSOR FOR '+candidate.sql,candidate.args)).rows[0]['QUERY PLAN'];
   load.sqlProfile=(await explain.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+candidate.sql,candidate.args)).rows[0]['QUERY PLAN'];
   await explain.query('COMMIT');
  }catch(error){await explain.query('ROLLBACK');load.profileError=String(error);}finally{explain.release();}
  load.memberBlocks=(await pool.query("SELECT count(*)::int n FROM metric_funnel_member_blocks b JOIN metric_funnel_runs r ON r.id=b.run_id WHERE r.query->>'datasetKey'='load'")).rows[0].n;
  const loadSaved=await save(lq,'Load saved funnel');console.log('Backfilling saved funnel');let start=performance.now();
  try{await drain();}catch(error){
   const failed=(await pool.query('SELECT initialized,processed_events,attempts,error,stats FROM metric_funnel_definitions d JOIN metric_funnel_subscriptions s ON s.definition_id=d.id WHERE s.library_id=$1',[loadSaved.id])).rows[0];
   load.backfill={ms:performance.now()-start,...failed};throw error;
  }
  const fillMs=performance.now()-start;
  const def=(await pool.query('SELECT d.* FROM metric_funnel_definitions d JOIN metric_funnel_subscriptions s ON s.definition_id=d.id WHERE s.library_id=$1',[loadSaved.id])).rows[0];
  load.backfill={ms:fillMs,stats:def.stats};console.log('Backfill complete in seconds:',fillMs/1000);
  console.log('Measuring materialized periods');const projected=await timedRun(lq);assert.deepEqual(counts(projected.done),expectedCounts);load.projected={ms:projected.ms,metadata:projected.metadata};
  const periods:any[]=load.periods=[];for(const [from,to] of [[0,7],[3,9],[2,5]]){const result=await timedRun({...lq,startsAt:at(from),endsAt:at(to)});
   const expected=[0,0,0,0];for(let person=1;person<=count;person++){
    const early=person%7,main=early+2,start=main+1/86400;
    if((early>=from&&early<to)||(start>=from&&start<to))expected[0]++;
    for(let stage=2;stage<=1+person%4;stage++)if(start>=from&&main+stage/86400<to)expected[stage-1]++;
   }assert.deepEqual(counts(result.done),expected);periods.push({from,to,ms:result.ms,counts:counts(result.done)});}
  const cache=[];for(let i=0;i<10;i++){start=performance.now();await call('metrics/event-funnel-runs',lq);cache.push(performance.now()-start);}
  start=performance.now();const concurrent=await Promise.all(Array.from({length:10},()=>call('metrics/event-funnel-runs',lq)));const concurrentReadMs=performance.now()-start;assert.ok(concurrent.every(r=>r.runId===projected.done.runId));
  // API ingestion of 100 conversions on existing actors, retaining full history.
  const additions=Array.from({length:100},(_,i)=>event('increment-'+i,'export',2+((i*4+2)%7)+.01,'user:'+(i*4+2)));
  start=performance.now();await ingest(additions,'load');const ingestMs=performance.now()-start;
  start=performance.now();await drain();const incrementalMs=performance.now()-start;const incrementalStats=(await pool.query('SELECT stats FROM metric_funnel_definitions WHERE id=$1',[def.id])).rows[0].stats;
  const after=await timedRun(lq);assert.deepEqual(counts(after.done),[count,count*.75,count*.5,count*.25+100]);
  const next=await call('metrics/event-funnel-runs/'+after.done.runId,{after:after.done.nextCursor});assert.equal(new Set([...after.done.participants,...next.participants].map((m:any)=>m.id)).size,100);
  Object.assign(load,{cachedReadMs:cache,concurrentCachedReads:{requests:10,totalMs:concurrentReadMs},incremental:{addedEvents:100,ingestMs,ms:incrementalMs,stats:incrementalStats,reportMs:after.ms},occurrences:(await pool.query('SELECT count(*)::int n FROM metric_funnel_occurrences WHERE definition_id=$1',[def.id])).rows[0].n,storageBytes:(await pool.query("SELECT pg_total_relation_size('metric_funnel_occurrences')::text bytes")).rows[0].bytes,rssMiB:Math.round(process.memoryUsage().rss/1024**2)});
  assert.ok(!load.baseline.error&&!load.warmBaseline.error,'Direct engine failed; preprocessing results are retained in the report.');
  checks.push('Load: exact configured cohort, direct timings, reusable periods, persisted drilldown, API incremental ingestion and bounded actor rebuilding');
 }
 report.checks=checks;report.completed=true;
}catch(e){report.checks=checks;report.error=e instanceof Error?e.message:String(e);throw e;}
finally{await pool?.end();if(report.error&&process.env.FUNNEL_LOAD_KEEP_ON_FAILURE==='1'){report.retainedSchema=schema;report.cleanedUp=false;}else{await root.query(`DROP SCHEMA ${schema} CASCADE`);report.cleanedUp=true;}await root.end();await writeFile(process.argv.includes('--load')?`experiments/metrics/funnel-projections-load${process.env.FUNNEL_LOAD_PEOPLE?'-'+process.env.FUNNEL_LOAD_PEOPLE:''}${process.env.FUNNEL_LOAD_LABEL?'-'+process.env.FUNNEL_LOAD_LABEL:''}.json`:'experiments/metrics/funnel-projections-acceptance.json',JSON.stringify(report,null,2)+'\n');const summary=structuredClone(report);if(summary.load){delete summary.load.cursorPlan;delete summary.load.sqlProfile;}console.log(JSON.stringify(summary,null,2));}
