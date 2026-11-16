import {processFunnelProjection} from '../src/server/metrics/funnel-projections';
import pg from 'pg';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL!);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Local PostgreSQL only.');
const schema='event_reporting_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.WAREHOUSE_ACCESS='local';delete process.env.VOYAGE_API_KEY;
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');const {processFunnelRun}=await import('../src/server/metrics/funnel-runs');
let pool:pg.Pool|undefined;const checks:string[]=[];
async function call(path:string,body?:unknown,token?:string,status=200){const r=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('/')})});const value=await r.json();if(path==='metrics/library-run'&&value.panels?.some((p:{processing?:boolean})=>p.processing)){while(await processFunnelProjection(pool!)){}while(await processFunnelRun(pool!)){}return call(path,body,token,status);}assert.equal(r.status,status,`${path}: ${JSON.stringify(value)}`);return value;}
try{
 await call('session');pool=await database();
 const grants={metrics:{read:[],write:[],eventRead:['app'],eventWrite:['app'],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
 const app=await call('integrations',{action:'create',name:'Reporting test',permissions:grants}),token=(await call('integrations',{action:'issue',id:app.id})).secret;
 const sourceId=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id).source_id;
 await call('metrics/datasets',{sourceId,key:'app',schema:{name:'string',person:'string',account:'string'}});
 await call('metrics/event-datasets',{sourceId,datasetKey:'app',schemaVersion:1,mapping:{name:'name',userId:'person',accountId:'account'},retentionDays:30});
 const base=new Date();base.setUTCHours(0,0,0,0);base.setUTCDate(base.getUTCDate()-3);const at=(d:number)=>new Date(+base+d*86400000).toISOString();
 const scope={sourceId,datasetKey:'app',schemaVersion:1,startsAt:at(0),endsAt:at(4)};
 const events=[{eventId:'open-1',occurredAt:at(.2),data:{name:'open',person:'ana',account:'acme'}},{eventId:'signup-1',occurredAt:at(1.2),data:{name:'signup',person:'ana',account:'acme'}},{eventId:'open-2',occurredAt:at(1.3),data:{name:'open',person:'ana',account:'acme'}},{eventId:'open-3',occurredAt:at(.4),data:{name:'open',person:'bob',account:'beta'}}];
 const ingest={datasetKey:'app',schemaVersion:1,events};await call('metrics/events',ingest,token,202);while(await processMetricBatch(pool)){}
 const originals=(await pool.query('SELECT record_id,hash,payload FROM metric_record_keys ORDER BY record_id')).rows;
 const input={sourceId,datasetKey:'app',schemaVersion:1,key:'daily_app_events',name:'Daily app events',includeHistory:true};
 await call('metrics/event-processing',input,token,403);
 const {authenticate}=await import('../src/server/access');const {metricPost}=await import('../src/server/metric-api');
 const staleRequest=new Request('http://localhost/api/v1/metrics/events',{method:'POST',headers:{Authorization:'Bearer '+token}}),stalePrincipal=await authenticate(pool,staleRequest);
 const {metric,job}=await call('metrics/event-processing',input);assert.equal(job.status,'queued');
 const mq={metricId:metric.id,startsAt:at(0),endsAt:at(4),interval:'day',groupBy:['name']};
 assert.equal((await call('metrics/query',mq)).quality,'recomputing');
 await assert.rejects(()=>processMetricBatch(pool!,2,true));assert.equal((await pool.query('SELECT count(*) n FROM metric_facts WHERE metric_id=$1',[metric.id])).rows[0].n,'0');
 await Promise.all([processMetricBatch(pool,2),processMetricBatch(pool,2)]);while(await processMetricBatch(pool,2)){}
 const q=await call('metrics/query',mq,token);assert.equal(Number(q.value),4);
 assert.deepEqual((await pool.query('SELECT record_id,hash,payload FROM metric_record_keys ORDER BY record_id')).rows,originals);
 assert.equal((await call('metrics/event-processing',input)).metric.id,metric.id);
 assert.equal((await call('metrics/event-processing')).jobs[0].inserted,'4');
 assert.equal((await call('metrics/events',ingest,token,202)).duplicates,4);
 assert.equal((await metricPost(pool,stalePrincipal,['events'],ingest,staleRequest) as {duplicates:number}).duplicates,4);
 checks.push('Daily counts: durable queue, rollback, concurrent workers, immutable originals, idempotent enablement and retries');
 await call('metrics/events',{...ingest,events:[{eventId:'future',occurredAt:at(2.1),data:{name:'signup',person:'bob',account:'beta'}}]},token,202);while(await processMetricBatch(pool)){}
 assert.equal(Number((await call('metrics/query',mq)).value),5);
 const futureOnly=await call('metrics/event-processing',{...input,key:'future_only',name:'Future only',includeHistory:false});while(await processMetricBatch(pool)){}assert.equal((await pool.query('SELECT count(*) n FROM metric_facts WHERE metric_id=$1',[futureOnly.metric.id])).rows[0].n,'0');
 const fquery={...scope,unit:'person',windowSeconds:3*86400,steps:[{name:'open'},{name:'signup'}]};
 const query=await call('metrics/library',{name:'Activation',kind:'query',visibility:'private',config:{eventFunnel:{query:fquery,period:'fixed'},chart:{kind:'funnel',orientation:'horizontal'}}});
 const view=await call('metrics/library',{name:'Activation view',kind:'view',visibility:'private',config:{queryIds:[query.id],chart:{kind:'funnel',stageTotals:true,orientation:'horizontal'}}});
 const dashboard=await call('metrics/library',{name:'Product dashboard',kind:'dashboard',visibility:'private',config:{viewIds:[view.id],layout:'grid'}});
 const run=await call('metrics/library-run',{id:dashboard.id});assert.deepEqual(run.panels[0].data.rows.map((r:{value:string})=>r.value),['2','2']);assert.equal(run.panels[0].data.measurementKind,'event_funnel');
 const dailyQuery=await call('metrics/library',{name:'Daily volume',kind:'query',visibility:'private',config:{query:{query:mq,period:'fixed',compare:false},chart:{kind:'line'}}});
 const mixed=await call('metrics/library',{name:'Invalid combined stages',kind:'view',visibility:'private',config:{queryIds:[query.id,dailyQuery.id],chart:{kind:'funnel',stageTotals:true}}});assert.match((await call('metrics/library-run',{id:mixed.id})).panels[0].error,/one event funnel/);
 await call('metrics/library-run',{id:dashboard.id},token,403);
 await call('metrics/library',{name:'Cannot leak private query',kind:'view',visibility:'company',config:{queryIds:[query.id],chart:{kind:'funnel',stageTotals:true}}},undefined,422);
 checks.push('Live event projections and future-only option; ordered cross-day distinct-person funnel saved into query/view/dashboard, with mixed-query and sharing boundaries');
 // Corrections must protect historical facts even though accepted envelopes had no projections.
 let state=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 await call('integrations',{action:'update',id:app.id,revision:state.revision,name:state.name,permissions:{...state.permissions,metrics:{...state.permissions.metrics,write:[]}}});
 await call('metrics/corrections',{mode:'events',tombstone:true,recordId:'open-1',revision:2,reason:'Test historical authorization'},token,404);
 state=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 await call('integrations',{action:'update',id:app.id,revision:state.revision,name:state.name,permissions:{...state.permissions,metrics:{...state.permissions.metrics,write:['daily_app_events','future_only']}}});
 await call('metrics/corrections',{mode:'events',tombstone:true,recordId:'open-1',revision:2,reason:'Test historical retraction'},token,202);while(await processMetricBatch(pool)){}
 assert.equal(Number((await call('metrics/query',mq)).value),4);
 assert.deepEqual((await call('metrics/library-run',{id:dashboard.id})).panels[0].data.rows.map((r:{value:string})=>r.value),['2','1']);
 checks.push('Historical projection authorization, retraction, rollup rebuild and live funnel refresh');
 // Enabling history later is explicit and idempotent, and honors purge tombstones.
 await call('metrics/event-processing',{...input,key:'future_only',name:'Future only',includeHistory:true});while(await processMetricBatch(pool,2)){}
 assert.equal(Number((await call('metrics/query',{...mq,metricId:futureOnly.metric.id})).value),4);
 const beforePurge=await call('metrics/purge-preview/'+metric.id,{dimensions:{name:'signup'}});
 await call('metrics/purge/'+metric.id,{dimensions:{name:'signup'},fingerprint:beforePurge.fingerprint,confirmationKey:metric.key,reason:'Verify historical replay honors explicit purge'});
 await pool.query("UPDATE metric_event_processing SET status='queued',cursor_at='-infinity',cursor_id='',cursor_revision=0 WHERE metric_id=$1",[metric.id]);while(await processMetricBatch(pool,2)){}
 assert.equal(Number((await call('metrics/query',mq)).value),2);
 checks.push('History can be enabled later; replay skips existing facts and never resurrects purged records');

 const report={at:new Date().toISOString(),passed:checks.length,checks};await writeFile('experiments/metrics/event-reporting-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await pool?.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
