import {processFunnelProjection} from '../src/server/metrics/funnel-projections';
import pg from 'pg';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Local PostgreSQL only.');
const schema='funnel_runs_'+Date.now(),root=new pg.Pool({connectionString:url.toString(),max:2});await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.WAREHOUSE_ACCESS='local';delete process.env.VOYAGE_API_KEY;
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');const {processFunnelRun,cleanFunnelRuns}=await import('../src/server/metrics/funnel-runs');
let pool:pg.Pool|undefined;const checks:string[]=[],report:Record<string,unknown>={at:new Date().toISOString(),scope:'Isolated local PostgreSQL. Functional API acceptance plus synthetic published index load; no production network or concurrent ingestion benchmark.'};
async function call(path:string,body?:unknown,token?:string,status=200){const r=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('/')})});const value=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(value)}`);return value;}
try{
 await call('session');pool=await database();
 const grants={metrics:{read:[],write:[],eventRead:['app','load'],eventWrite:['app','load'],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
 const app=await call('integrations',{action:'create',name:'Funnel worker test',permissions:grants}),token=(await call('integrations',{action:'issue',id:app.id})).secret;
 const sourceId=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id).source_id;
 const ds={name:'string',person:'string',account:'string',properties:'properties'};
 for(const key of ['app','load']){await call('metrics/datasets',{sourceId,key,schema:ds});await call('metrics/event-datasets',{sourceId,datasetKey:key,schemaVersion:1,mapping:{name:'name',userId:'person',accountId:'account',properties:'properties'},retentionDays:30});}
 const base=new Date(Date.now()-10*86400000);base.setUTCHours(0,0,0,0);const at=(d:number)=>new Date(+base+d*86400000).toISOString();
 const q={sourceId,datasetKey:'app',schemaVersion:1,startsAt:at(0),endsAt:at(9),unit:'person',windowSeconds:86400,steps:[{name:'open'},{name:'export',properties:{paid:true}}]};
 const events=[['a','open',.1,'user:a',{}],['b','open',2.1,'user:a',{}],['c','export',2.2,'user:a',{paid:true}],['d','open',2.3,'user:b',{}],['e','export',2.4,'user:b',{paid:'true'}],['f','open',2.5,'user:c',{}],['g','export',3.5,'user:c',{paid:true}]].map(([eventId,name,t,person,properties])=>({eventId,occurredAt:at(Number(t)),data:{name,person,account:'acme',properties}}));
 await call('metrics/events',{datasetKey:'app',schemaVersion:1,events},token,202);while(await processMetricBatch(pool)){}
 const legacy=await call('metrics/event-funnel',q,token);
 const [first,second]=await Promise.all([call('metrics/event-funnel-runs',q,token),call('metrics/event-funnel-runs',q,token)]);assert.equal(first.runId,second.runId);assert.equal(first.status,'queued');assert.deepEqual(first.steps,[]);
 await Promise.all([processFunnelRun(pool,{batchSize:2}),processFunnelRun(pool,{batchSize:2})]);
 const result=await call('metrics/event-funnel-runs/'+first.runId,{stage:2},token);assert.equal(result.status,'completed');assert.deepEqual(result.steps,legacy.steps);assert.deepEqual(result.participants.map((p:{id:string})=>p.id),['user:a','user:c']);
 assert.equal((await call('metrics/event-funnel-runs',q,token)).runId,first.runId);
 checks.push('Exact cross-day sequence, repeated starts, inclusive window, typed filters, batch boundaries, durable queue and concurrent deduplication');
 const comparison={...q,endsAt:at(3)};const pending=await call('metrics/event-funnel-runs',comparison,token);
 await assert.rejects(()=>processFunnelRun(pool!,{batchSize:1,failAfterBatch:true}));assert.equal((await call('metrics/event-funnel-runs/'+pending.runId,{},token)).steps.length,0);
 await pool.query("UPDATE metric_funnel_runs SET available_at=now() WHERE id=$1",[pending.runId]);await processFunnelRun(pool,{batchSize:1});const retried=await call('metrics/event-funnel-runs/'+pending.runId,{},token);assert.deepEqual(retried.steps.map((s:{count:number})=>s.count),[3,1]);
 assert.equal((await pool.query('SELECT attempts FROM metric_funnel_runs WHERE id=$1',[pending.runId])).rows[0].attempts,2);
 checks.push('Failed batches are invisible; retry restarts a snapshot without double counting');
 const cancel=await call('metrics/event-funnel-runs',{...q,unit:'account'},token);await call('metrics/event-funnel-runs/'+cancel.runId,{action:'cancel'},token);assert.equal((await call('metrics/event-funnel-runs',{...q,unit:'account'},token)).status,'cancelled');
 checks.push('Cancellation does not automatically requeue on polling');
 await call('metrics/corrections',{mode:'events',recordId:'c',revision:2,tombstone:true,reason:'Funnel correction'},token,202);while(await processMetricBatch(pool)){}
 assert.equal((await call('metrics/event-funnel-runs/'+first.runId,{},token)).status,'invalidated');
 const corrected=await call('metrics/event-funnel-runs',q,token);assert.notEqual(corrected.runId,first.runId);await processFunnelRun(pool);assert.deepEqual((await call('metrics/event-funnel-runs/'+corrected.runId,{},token)).steps.map((s:{count:number})=>s.count),[3,1]);
 const denied={...grants,metrics:{...grants.metrics,eventRead:[]}};const state=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);await call('integrations',{action:'update',id:app.id,revision:state.revision,name:state.name,permissions:denied});await call('metrics/event-funnel-runs/'+corrected.runId,{},token,403);
 checks.push('Corrections invalidate cached participants immediately; cached reads recheck current grants');
 const saved=await call('metrics/library',{name:'Comparison',kind:'query',visibility:'private',config:{eventFunnel:{query:q,period:'fixed',compare:'custom',compareStartsAt:at(0),compareEndsAt:at(3)},chart:{kind:'funnel',stageTotals:true}}});
 let dashboard=await call('metrics/library-run',{id:saved.id});while(dashboard.panels[0].processing){while(await processFunnelProjection(pool)){}while(await processFunnelRun(pool)){}dashboard=await call('metrics/library-run',{id:saved.id});}
 assert.deepEqual(dashboard.panels[0].data.rows.map((r:{value:string;previous:string})=>[r.value,r.previous]),[['3','3'],['1','0']]);
 checks.push('Library reports queue and expose independent comparison-period counts');

 // Identity linking changes existing results without rewriting accepted originals.
 const latest=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);await call('integrations',{action:'update',id:app.id,revision:latest.revision,name:latest.name,permissions:grants});
 const anon='anon:11111111-1111-4111-8111-111111111111';
 await call('metrics/events',{datasetKey:'app',schemaVersion:1,events:[{eventId:'alias-open',occurredAt:at(4),data:{name:'alias-open',person:anon,account:'acme',properties:{}}},{eventId:'alias-export',occurredAt:at(4.1),data:{name:'alias-export',person:'user:linked',account:'acme',properties:{}}}]},token,202);while(await processMetricBatch(pool)){}
 const aq={...q,steps:[{name:'alias-open'},{name:'alias-export'}]};const beforeLink=await call('metrics/event-funnel-runs',aq);await processFunnelRun(pool);assert.deepEqual((await call('metrics/event-funnel-runs/'+beforeLink.runId,{})).steps.map((x:{count:number})=>x.count),[1,0]);
 await call('metrics/event-identify',{datasetKey:'app',schemaVersion:1,anonymousId:anon,userId:'user:linked'},token);
 assert.equal((await call('metrics/event-funnel-runs/'+beforeLink.runId,{})).status,'invalidated');const afterLink=await call('metrics/event-funnel-runs',aq);await processFunnelRun(pool);assert.deepEqual((await call('metrics/event-funnel-runs/'+afterLink.runId,{})).steps.map((x:{count:number})=>x.count),[1,1]);
 // A correction during iteration must not change the worker snapshot. Its old
 // result is stored consistently but cannot be served after hard invalidation.
 const cq={...aq,windowSeconds:86401};const concurrent=await call('metrics/event-funnel-runs',cq);let changed=false;
 await processFunnelRun(pool,{batchSize:1,afterBatch:async()=>{if(changed)return;changed=true;await pool!.query("DELETE FROM metric_event_index WHERE source_id=$1 AND record_id='alias-export'",[sourceId]);}});
 assert.deepEqual((await pool.query('SELECT counts FROM metric_funnel_runs WHERE id=$1',[concurrent.runId])).rows[0].counts,[1,1]);assert.equal((await call('metrics/event-funnel-runs/'+concurrent.runId,{})).status,'invalidated');
 await cleanFunnelRuns(pool);assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_members WHERE run_id=$1',[concurrent.runId])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_member_blocks WHERE run_id=$1',[concurrent.runId])).rows[0].n,0);
 checks.push('Identity linking invalidates cached cohorts; concurrent deletion preserves snapshot consistency and blocks old results; cleanup removes invalid participants');
 const budget=await call('metrics/event-funnel-runs',{...aq,windowSeconds:86402});
 for(let i=0;i<3;i++){await processFunnelRun(pool,{deadlineMs:0});await pool.query('UPDATE metric_funnel_runs SET available_at=now() WHERE id=$1',[budget.runId]);}
 const exhausted=await call('metrics/event-funnel-runs/'+budget.runId,{});assert.equal(exhausted.status,'failed');assert.deepEqual(exhausted.steps,[]);assert.match(exhausted.error,/budget/);
 const recovery=await call('metrics/event-funnel-runs/'+budget.runId,{action:'retry'});await pool.query("UPDATE metric_funnel_runs SET status='running',lease_until=now()-interval '1 minute',lease_token=gen_random_uuid() WHERE id=$1",[recovery.runId]);await processFunnelRun(pool);assert.equal((await call('metrics/event-funnel-runs/'+recovery.runId,{})).status,'completed');
 checks.push('Total budget errors stop after three attempts; explicit retry and expired-lease recovery complete safely');
 // Pagination crosses compressed-block boundaries and preserves PostgreSQL C ordering.
 const pageActors=[...Array.from({length:5000},(_,i)=>'page:'+String(i).padStart(5,'0')),'page:\uE000','page:😀'].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 const pageEvents=pageActors.flatMap((person,i)=>[{eventId:'po'+i,occurredAt:at(7),data:{name:'page-open',person,account:'pages',properties:{}}},...(i%257===0?[{eventId:'pe'+i,occurredAt:at(7.01),data:{name:'page-export',person,account:'pages',properties:{}}}]:[])]);
 for(let i=0;i<pageEvents.length;i+=1000){await call('metrics/events',{datasetKey:'app',schemaVersion:1,events:pageEvents.slice(i,i+1000)},token,202);while(await processMetricBatch(pool)){} }
 const pq={...q,steps:[{name:'page-open'},{name:'page-export'}]},pageRun=await call('metrics/event-funnel-runs',pq);await processFunnelRun(pool);
 const pageRead=async(body:unknown)=>call('metrics/event-funnel-runs/'+pageRun.runId,body);
 assert.deepEqual((await pageRead({})).steps.map((s:any)=>s.count),[pageActors.length,20]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_member_blocks WHERE run_id=$1',[pageRun.runId])).rows[0].n,2);
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_funnel_members WHERE run_id=$1',[pageRun.runId])).rows[0].n,0);
 for(const start of [4070,4095,4990])assert.deepEqual((await pageRead({after:pageActors[start]})).participants.map((m:any)=>m.id),pageActors.slice(start+1,start+51));
 assert.deepEqual((await pageRead({stage:2})).participants.map((m:any)=>m.id),pageActors.filter((_,i)=>i%257===0));
 assert.deepEqual((await pageRead({stage:1,outcome:'dropped',after:pageActors[4090]})).participants.map((m:any)=>m.id),pageActors.filter((_,i)=>i>4090&&i%257!==0).slice(0,50));
 checks.push('Compact snapshots preserve cross-block pagination, sparse stage filtering, drop-offs and Unicode identity ordering');
 // Simulate a completed snapshot created before the compact storage migration.
 await pool.query('INSERT INTO metric_funnel_members(run_id,attempt,actor,reached) SELECT run_id,attempt,unnest(actors),unnest(reached) FROM metric_funnel_member_blocks WHERE run_id=$1',[pageRun.runId]);
 await pool.query("UPDATE metric_funnel_runs SET metadata=metadata-'memberFormat' WHERE id=$1",[pageRun.runId]);
 await pool.query('DELETE FROM metric_funnel_member_blocks WHERE run_id=$1',[pageRun.runId]);
 assert.deepEqual((await pageRead({stage:2})).participants.map((m:any)=>m.id),pageActors.filter((_,i)=>i%257===0));
 assert.deepEqual((await pageRead({after:pageActors[4070]})).participants.map((m:any)=>m.id),pageActors.slice(4071,4121));
 checks.push('Previously completed row-based snapshots remain readable with exact stage filtering and pagination');
 if(process.argv.includes('--load')){
  const loadStart=performance.now(),count=Number(process.env.FUNNEL_LOAD_PEOPLE??150000);assert(Number.isInteger(count)&&count>=100&&count<=1000000);
  const c=await pool.connect();try{
   await c.query("BEGIN; SET LOCAL statement_timeout='120s'");
   const receipt=(await c.query("INSERT INTO metric_ingestions(id,source_id,status,record_count,payload_hash) VALUES(gen_random_uuid(),$1,'completed',0,'synthetic') RETURNING id",[sourceId])).rows[0].id;
   await c.query(`CREATE TEMP TABLE generated ON COMMIT DROP AS SELECT g::text actor,(g::bigint*10+s)::text id,($2::timestamptz+(g%7)*interval '1 day'+s*interval '1 second') at,(ARRAY['open','signup','use','export'])[s] name FROM generate_series(1,$1::int) g CROSS JOIN generate_series(1,4) s WHERE s<=1+g%4`,[count,at(2)]);
   await c.query(`INSERT INTO generated SELECT g::text,(g::bigint*10)::text,$2::timestamptz+(g%7)*interval '1 day','open' FROM generate_series(1,$1::int) g`,[count,at(0)]);
   await c.query(`INSERT INTO metric_record_keys(source_id,record_id,revision,hash,ingestion_id,payload,processed)
    SELECT $1,'load-'||id,1,'synthetic', $2,jsonb_build_object('projections','[]'::jsonb,'original',jsonb_build_object('mode','events','datasetKey','load','schemaVersion',1,'record',jsonb_build_object('occurredAt',at,'data',jsonb_build_object('name',name,'person','user:'||actor,'account','group:'||actor,'properties',jsonb_build_object('paid',true))))),true FROM generated`,[sourceId,receipt]);
   await c.query(`INSERT INTO metric_event_index SELECT $1,'load-'||id,1,'load',1,at,name,'user:'||actor,'group:'||actor,NULL FROM generated`,[sourceId]);
   await c.query('ANALYZE metric_event_index');await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  const lq={...q,datasetKey:'load',startsAt:at(0),endsAt:at(10),steps:[{name:'open'},{name:'signup'},{name:'use'},{name:'export',properties:{paid:true}}]};
  const queued=await call('metrics/event-funnel-runs',lq),begin=performance.now();await processFunnelRun(pool);const done=await call('metrics/event-funnel-runs/'+queued.runId,{});assert.equal(done.status,'completed');assert.deepEqual(done.steps.map((s:{count:number})=>s.count),[count,count*.75,count*.5,count*.25]);
  const elapsed=performance.now()-begin,times=[];for(let i=0;i<10;i++){const t=performance.now();const cache=await call('metrics/event-funnel-runs',lq);assert.equal(cache.runId,queued.runId);times.push(performance.now()-t);}
  const next=await call('metrics/event-funnel-runs/'+queued.runId,{after:done.nextCursor});assert.equal(new Set([...done.participants,...next.participants].map((m:{id:string})=>m.id)).size,100);
  report.load={participants:count,events:done.processedEvents,counts:done.steps,workerAndReadMs:Math.round(elapsed),fixtureAndRunMs:Math.round(performance.now()-loadStart),cachedReadMs:times.map(n=>Math.round(n*100)/100),rssMiB:Math.round(process.memoryUsage().rss/1024**2),memberRows:(await pool.query('SELECT count(*) n FROM metric_funnel_members WHERE run_id=$1',[queued.runId])).rows[0].n};checks.push('Large real index/property query, persistent participants, cached reads and keyset pagination');
 }
 report.checks=checks;report.passed=checks.length;report.completed=true;
}finally{await pool?.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();report.cleanedUp=true;await writeFile(process.argv.includes('--load')?'experiments/metrics/funnel-runs-report.json':'experiments/metrics/funnel-runs-acceptance-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
