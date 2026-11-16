/** Local, isolated, bounded load benchmark. No production hosts or credentials are accepted. */
import pg from 'pg';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {createAnalyticsRelay,browserDatasetSchema,browserEventMapping} from '../sdk/javascript/src/relay';
import {WarehouseClient} from '../sdk/javascript/src/server';
const url=new URL(process.env.DATABASE_URL!);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'This benchmark only runs against local PostgreSQL.');
const schema='events_load_'+Date.now(),root=new pg.Pool({connectionString:url.toString(),max:2});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.WAREHOUSE_ACCESS='local';delete process.env.VOYAGE_API_KEY;
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');
const upstreamEventStatuses:Record<string,number>={};
let pool:pg.Pool|undefined,origin='',relay:ReturnType<typeof createAnalyticsRelay>|undefined,stop=false;const workerErrors:string[]=[];
const report:Record<string,unknown>={at:new Date().toISOString(),configuration:{workers:2,workerBatchSize:1000,idlePollMs:20,largeBatchSize:1000,querySamples:25,relayBatchSize:20},scope:'Synthetic isolated local PostgreSQL schema; real loopback HTTP to route handlers, not a Next.js server, real browser or production network',environment:{node:process.version,platform:os.platform(),cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,loadAverageAtStart:os.loadavg(),ramGiB:Math.round(os.totalmem()/1024**3)},phases:[],workerErrors};
const server=createServer(async(req,res)=>{try{const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const path=req.url!;const request=new Request(origin+path,{method:req.method,headers:req.headers as Record<string,string>,...(req.method==='POST'?{body:Buffer.concat(parts)}:{})});const result=path==='/analytics/events'?await relay!(request):await(req.method==='GET'?GET:POST)(request,{params:Promise.resolve({operation:path.replace('/api/v1/','').split('/')})});if(path==='/api/v1/metrics/events')upstreamEventStatuses[result.status]=(upstreamEventStatuses[result.status]??0)+1;res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch{res.writeHead(500);res.end('Harness failure');}});
function stats(values:number[]){const sorted=[...values].sort((a,b)=>a-b),p=(n:number)=>Math.round((sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*n)-1)]??0)*100)/100;return {samples:values.length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),maxMs:p(1)};}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function call(path:string,body?:unknown,token?:string){const r=await fetch(origin+'/api/v1/'+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,`${path}: ${r.status} ${data.error}`);return data;}
const start=Date.now()-2*86400000,at=(i:number)=>new Date(start+i*1000).toISOString();
const grant={metrics:{read:[],write:[],eventRead:['web'],eventWrite:['web'],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
async function fixture(name:string,project=false){const app=await call('integrations',{action:'create',name,permissions:grant});const token=(await call('integrations',{action:'issue',id:app.id})).secret;const state=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);const sourceId=state.source_id;await call('metrics/datasets',{sourceId,key:'web',schema:browserDatasetSchema});await call('metrics/event-datasets',{sourceId,datasetKey:'web',schemaVersion:1,mapping:browserEventMapping,retentionDays:30});if(project){await call('metrics/definitions',{definition:{key:'load_count',name:'Load count',sourceId,inputMode:'events',datasetKey:'web',kind:'count',unit:'events',dimensions:[],status:'active',timezone:'UTC',storagePolicy:{baseResolution:'hour',baseRetentionDays:30,hourRetentionDays:30,dayRetentionDays:365,rawRetentionDays:30}}});await call('integrations',{action:'update',id:app.id,revision:state.revision,name,permissions:{...grant,metrics:{...grant.metrics,write:['load_count']}}});}return {sourceId,token};}
const makeEvent=(i:number)=>({eventId:'load-'+i,occurredAt:at(i),data:{name:['opened','signup','used'][i%3],person:'user:'+Math.floor(i/3),account:'account-'+Math.floor(i/30),session:'session-'+Math.floor(i/3),properties:{feature:'reports',paid:i%2===0,payload:'x'.repeat(100)}}});
let workers:Promise<void>[]=[];
try{
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;await call('session');pool=await database();
 report.database=(await pool.query("SELECT version(),current_setting('shared_buffers') shared_buffers,current_setting('max_connections') max_connections")).rows[0];
 const rssStart=process.memoryUsage().rss;let peakRss=rssStart;const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);sampler.unref();
 workers=Array.from({length:2},async()=>{while(!stop){try{const n=await processMetricBatch(pool!,1000);if(!n)await sleep(20);}catch(e){workerErrors.push(String(e));stop=true;}}});
 async function drain(){const began=performance.now();while((await pool!.query('SELECT count(*)::int n FROM metric_record_keys WHERE NOT processed')).rows[0].n){assert(!stop,'Worker failed');assert(performance.now()-began<120000,'Drain timeout');await sleep(50);}return performance.now()-began;}
 const direct=await fixture('Load direct');let offset=0;
 async function phase(label:string,source:typeof direct,count:number,concurrency:number){
  const begin=performance.now(),latencies:number[]=[],readLatencies:number[]=[];let next=0,accepted=0,errors=0,maxBacklog=0,monitoring=true;
  const monitor=(async()=>{while(monitoring){maxBacklog=Math.max(maxBacklog,(await pool!.query('SELECT count(*)::int n FROM metric_record_keys WHERE NOT processed')).rows[0].n);const t=performance.now();await call('metrics/event-timeline',{sourceId:source.sourceId,datasetKey:'web',schemaVersion:1,startsAt:at(-1),endsAt:at(110000),accountId:'account-1'});readLatencies.push(performance.now()-t);await sleep(200);}})();
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const batch=next++;if(batch>=count/1000)break;const events=Array.from({length:1000},(_,j)=>makeEvent(offset+batch*1000+j)),t=performance.now();try{const r=await call('metrics/events',{datasetKey:'web',schemaVersion:1,events},source.token);accepted+=r.accepted;}catch{errors++;}latencies.push(performance.now()-t);}}));
  const acceptedMs=performance.now()-begin,drainMs=await drain();monitoring=false;await monitor;
  const result={label,events:count,accepted,concurrency,batchSize:1000,errors,ingestMs:Math.round(acceptedMs),acceptedEventsPerSecond:Math.round(accepted/(acceptedMs/1000)),ingestAndDrainMs:Math.round(acceptedMs+drainMs),drainMs:Math.round(drainMs),maxSampledBacklog:maxBacklog,request:stats(latencies),timelineDuringWrites:stats(readLatencies)};
  (report.phases as unknown[]).push(result);console.log(JSON.stringify(result));assert.equal(accepted,count);assert.equal(errors,0);offset+=count;
 }
 await phase('event-only-20k',direct,20000,1);await phase('event-only-30k',direct,30000,4);await phase('event-only-50k',direct,50000,8);
 const projected=await fixture('Load with count projection',true);offset=0;await phase('events-and-count-metric-20k',projected,20000,4);
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_event_index WHERE source_id=$1',[direct.sourceId])).rows[0].n,100000);
 assert.equal((await pool.query('SELECT count(*)::int n FROM metric_facts WHERE source_id=$1',[projected.sourceId])).rows[0].n,20000);
 const retry=await call('metrics/events',{datasetKey:'web',schemaVersion:1,events:Array.from({length:1000},(_,i)=>makeEvent(i))},direct.token);assert.equal(retry.duplicates,1000);report.retryDeduplicated=retry.duplicates;
 const scope={sourceId:direct.sourceId,datasetKey:'web',schemaVersion:1,startsAt:at(-1),endsAt:at(100000)};const queryReport:Record<string,unknown>={};
 for(const [name,path,body] of [
  ['accountTimeline','event-timeline',{...scope,accountId:'account-10'}],
  ['personTimeline','event-timeline',{...scope,userId:'user:100'}],
  ['funnel15k','event-funnel',{...scope,endsAt:at(15000),steps:[{name:'opened'},{name:'signup'},{name:'used'}]}],
 ] as const){const times:number[]=[];let last;for(let i=0;i<25;i++){const t=performance.now();last=await call('metrics/'+path,body);times.push(performance.now()-t);}queryReport[name]={...stats(times),...(last.steps?{counts:last.steps.map((s:{count:number})=>s.count)}:{rows:last.events.length})};}
 assert.deepEqual((queryReport.funnel15k as {counts:number[]}).counts,[5000,5000,5000]);
 const rejectStart=performance.now();const big=await fetch(origin+'/api/v1/metrics/event-funnel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,steps:[{name:'opened'},{name:'signup'},{name:'used'}]})});assert.equal(big.status,422);queryReport.funnel100k={status:big.status,elapsedMs:Math.round(performance.now()-rejectStart),body:await big.json()};report.queries=queryReport;
 const {eventTimelineSql}=await import('../src/server/metrics/events');
 report.personQueryPlanScope='Exact timeline SQL including alias resolution, pagination and raw-payload join.';
 report.personQueryPlan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+eventTimelineSql(true),[direct.sourceId,'web',1,at(-1),at(100000),null,'user:100',null,null,null,51])).rows[0]['QUERY PLAN'];
 const priorUpstream={...upstreamEventStatuses};
 const browser=await fixture('Load browser relay');relay=createAnalyticsRelay({origin,datasetKey:'web',schemaVersion:1,signingSecret:randomUUID()+randomUUID(),client:new WarehouseClient(origin,browser.token),resolveIdentity:async()=>null,allowRequest:async()=>true});
 const context=await(await fetch(origin+'/analytics/events',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({action:'context'})})).json();
 let probeEvents:unknown[]=[];const statuses:Record<string,number>={},times:number[]=[];let cursor=0;const browserBegin=performance.now();
 await Promise.all(Array.from({length:4},async()=>{for(;;){const batch=cursor++;if(batch>=300)break;const events=Array.from({length:20},()=>({eventId:'web:'+randomUUID(),occurredAt:new Date().toISOString(),name:'feature_used',sessionId:randomUUID(),properties:{feature:'reports'},context}));if(batch===0)probeEvents=events;const t=performance.now();const r=await fetch(origin+'/analytics/events',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({action:'capture',events})});await r.arrayBuffer();times.push(performance.now()-t);statuses[r.status]=(statuses[r.status]??0)+1;}}));
 const browserMs=performance.now()-browserBegin;await drain();report.browserRelay={offeredEvents:6000,requests:300,concurrency:4,batchSize:20,elapsedMs:Math.round(browserMs),statuses,request:stats(times),upstreamStatuses:Object.fromEntries(Object.entries(upstreamEventStatuses).map(([status,n])=>[status,n-(priorUpstream[status]??0)])),storedEvents:(await pool.query('SELECT count(*)::int n FROM metric_event_index WHERE source_id=$1',[browser.sourceId])).rows[0].n,admission:'Relay allowRequest=true to isolate the existing Warehouse integration quota; no simulated browser retries'};
 assert.equal(statuses['202'],300);assert.equal((report.browserRelay as {storedEvents:number}).storedEvents,6000);
 const browserApp=(await pool.query('SELECT id FROM warehouse_apps WHERE source_id=$1',[browser.sourceId])).rows[0].id;
 await pool.query("UPDATE warehouse_event_rate_limits SET requests=2400,window_start=date_trunc('minute',now()) WHERE app_id=$1",[browserApp]);
 const retryBody=JSON.stringify({action:'capture',events:probeEvents});
 const limited=await fetch(origin+'/analytics/events',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:retryBody});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');await limited.arrayBuffer();
 await pool.query("UPDATE warehouse_event_rate_limits SET window_start=now()-interval '1 minute' WHERE app_id=$1",[browserApp]);
 const recovered=await fetch(origin+'/analytics/events',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:retryBody});const recovery=await recovered.json();assert.equal(recovered.status,202);assert.equal(recovery.receipt.duplicates,20);
 report.quotaProbe={method:'Synthetic quota exhaustion and database window expiry; no wall-clock wait',status:limited.status,retryAfter:limited.headers.get('retry-after'),recovered:recovered.status,duplicates:recovery.receipt.duplicates};
 report.storage=(await pool.query("SELECT relname,pg_total_relation_size(relid)::bigint bytes FROM pg_statio_user_tables WHERE schemaname=$1 ORDER BY pg_total_relation_size(relid) DESC LIMIT 8",[schema])).rows;
 report.reconciliation=(await pool.query('SELECT (SELECT count(*)::int FROM metric_record_keys) raw_records,(SELECT count(*)::int FROM metric_event_index) indexed_events,(SELECT count(*)::int FROM metric_facts) metric_facts')).rows[0];assert.equal((report.reconciliation as {raw_records:number}).raw_records,120000+(report.browserRelay as {storedEvents:number}).storedEvents);
 report.pending=(await pool.query('SELECT count(*)::int n FROM metric_record_keys WHERE NOT processed')).rows[0].n;report.processRssMiB={start:Math.round(rssStart/1024**2),peak:Math.round(peakRss/1024**2)};clearInterval(sampler);assert.equal(report.pending,0);assert.equal(workerErrors.length,0);report.completed=true;
}finally{
 stop=true;await Promise.allSettled(workers);await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();report.cleanedUp=true;
 await mkdir('experiments/metrics',{recursive:true});await writeFile('experiments/metrics/events-load-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
