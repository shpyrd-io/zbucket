// Exercise the deployed HTTP handlers in a disposable schema; never call providers.
delete process.env.VOYAGE_API_KEY;
import pg from 'pg';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {emptyPermissions} from '../src/models/permissions';
const url=new URL(process.env.DATABASE_URL!),schema='warehouse_management_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.ZBUCKET_ACCESS='local';
const routes=await import('../app/api/v1/[...operation]/route');
const {database}=await import('../src/server/database');
const {processMetricBatch}=await import('../src/server/metrics/worker');
const checks:string[]=[];
async function call(method:'GET'|'POST'|'PATCH'|'DELETE',path:string,body?:unknown,token?:string,status:number|number[]=200){
 const response=await routes[method](new Request('http://localhost/api/v1/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(method!=='GET'&&body?{body:JSON.stringify(body)}:{})}),{params:Promise.resolve({operation:path.split('?')[0].split('/')})});
 const result=await response.json();assert.ok((Array.isArray(status)?status:[status]).includes(response.status),`${response.status} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const grants={...emptyPermissions,metrics:{...emptyPermissions.metrics,manageOwn:true}};
async function app(name:string,manageOwn=true){const a=await call('POST','integrations',{action:'create',name,permissions:manageOwn?grants:emptyPermissions});const credential=await call('POST','integrations',{action:'issue',id:a.id});return {...a,token:credential.secret};}
const spec=(key:string)=>({definition:{key,name:key,kind:'sum',unit:'USD',inputMode:'measurements',status:'active',dimensions:['region']}});
const point=(key:string)=>({measurements:[{measurementId:key+'-one',metricKey:key,observedAt:new Date().toISOString(),value:'23.45',unit:'USD',dimensions:{region:'BR'}}]});
const del=(key:string,token:string,revision=1,status=200)=>call('DELETE','metrics/definitions/'+key,{expectedRevision:revision},token,status);
try{
 const pool=await database(),a=await app('Publisher'),b=await app('Other publisher'),disabled=await app('Default deny',false);
 const create=async(key:string,token=a.token)=>call('POST','metrics/definitions',spec(key),token,201);
 await call('POST','metrics/definitions',spec('denied'),disabled.token,403);
 const first=await create('revenue');assert.equal(first.created,true);
 let settings=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);
 assert.equal(settings.revision,2);assert.deepEqual(settings.permissions.metrics.read,['revenue']);assert.deepEqual(settings.permissions.metrics.write,['revenue']);assert.equal(first.metric.sourceId,settings.source_id);
 assert.equal((await call('GET','metrics/definition/revenue',undefined,a.token)).metric.id,first.metric.id);
 assert.equal((await call('GET','metrics/catalog',undefined,a.token)).metrics.length,1);
 await call('POST','integrations',{action:'update',...settings,revision:1},undefined,409);
 checks.push('Explicit opt-in, publisher identity and atomic read/write grants; stale administrator edits cannot erase grants.');
 const retries=await Promise.all([call('POST','metrics/definitions',spec('revenue'),a.token),call('POST','metrics/definitions',spec('revenue'),a.token)]);assert.ok(retries.every(r=>!r.created&&r.metric.id===first.metric.id));
 await call('POST','metrics/definitions',{definition:{...spec('revenue').definition,unit:'BRL'}},a.token,409);
 await call('POST','metrics/definitions',spec('revenue'),b.token,409);
 await call('PATCH','metrics/definitions/revenue',{expectedRevision:1,changes:{name:'Stolen'}},b.token,404);
 await del('revenue',b.token,1,404);
 await call('POST','metrics/definitions',{definition:{...spec('injected').definition,sourceId:settings.source_id}},a.token,422);
 await call('POST','metrics/definitions/revenue',{name:'Wrong method'},a.token,405);
 await call('PATCH','integrations',{action:'create',name:'Exploit'},a.token,405);
 checks.push('Concurrent identical registration is idempotent; key conflicts, foreign ownership and source/method injection are rejected.');
 const update=await call('PATCH','metrics/definitions/revenue',{expectedRevision:1,changes:{name:'Revenue',description:'Published by app',category:'Finance',direction:'higher',maxSeries:200}},a.token);
 assert.equal(update.metric.revision,2);assert.equal(update.metric.id,first.metric.id);assert.equal(update.metric.version,1);
 for(const change of [{kind:'latest'},{dimensions:['account_id']},{timezone:'America/Sao_Paulo'},{missingData:'keep_previous'},{unit:'BRL'}])await call('PATCH','metrics/definitions/revenue',{expectedRevision:2,changes:change},a.token,409);
 await call('PATCH','metrics/definitions/revenue',{expectedRevision:1,changes:{name:'Stale'}},a.token,409);
 assert.equal((await call('POST','metrics/definitions',spec('revenue'),a.token)).metric.name,'Revenue');
 checks.push('Metadata edits preserve identity/data contract, enforce revision and survive repeated startup publication.');
 await call('POST','metrics/measurements',point('revenue'),a.token,202);
 await del('revenue',a.token,2,409);await processMetricBatch(pool);await del('revenue',a.token,2,409);
 const query={metricId:'revenue',startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+1000).toISOString()};
 assert.equal(Number((await call('POST','metrics/query',query,a.token)).value),23.45);
 checks.push('Auto-granted credentials ingest and query immediately; queued and processed data both block deletion.');
 const empty=await create('empty');await del('empty',a.token,2,409);const deleted=await del('empty',a.token);assert.equal(deleted.id,empty.metric.id);await del('empty',a.token);
 await call('GET','metrics/definition/empty',undefined,a.token,404);await call('POST','metrics/definitions',spec('empty'),a.token,409);
 await call('POST','metrics/definitions',{definition:{...spec('empty').definition,sourceId:settings.source_id}},undefined,409);
 settings=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);assert.ok(!settings.permissions.metrics.read.includes('empty'));
 assert.equal((await pool.query("SELECT count(*) n FROM metric_activity WHERE metric_id=$1 AND action='empty_metric_deleted'",[empty.metric.id])).rows[0].n,'1');
 checks.push('Empty deletion removes definition/grants, retains audit, supports retries and reserves the stable key.');
 await create('covered');const times={startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date().toISOString()};
 await call('POST','metrics/coverage',{metricKey:'covered',dimensions:{region:'BR'},...times},a.token);await del('covered',a.token,1,409);
 // Simulate retention/purge removing all current materializations: lifetime usage still prevents deletion.
 await pool.query("DELETE FROM metric_coverage WHERE metric_id=(SELECT id FROM metrics WHERE key='covered')");await del('covered',a.token,1,409);
 checks.push('Coverage and a durable usage marker block deletion even after data is removed by retention or cleanup.');
 const event={definition:{key:'order_value',name:'Order value',kind:'sum',unit:'USD',inputMode:'events',datasetKey:'orders',dimensions:['region'],status:'active'},dataset:{version:1,schema:{value:'decimal',region:'string'}}};
 await call('POST','metrics/definitions',event,a.token,201);
 await call('POST','metrics/events',{datasetKey:'orders',schemaVersion:1,events:[{eventId:'first-order',occurredAt:new Date().toISOString(),data:{value:'12.30',region:'BR'}}]},a.token,202);await processMetricBatch(pool);
 await call('POST','metrics/definitions',{...event,definition:{...event.definition,key:'order_other'},dataset:{version:1,schema:{value:'decimal',region:'string',extra:'string'}}},a.token,409);
 assert.equal((await pool.query("SELECT count(*) n FROM metrics WHERE key='order_other'")).rows[0].n,'0');
 const afterRollback=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);assert.ok(!afterRollback.permissions.metrics.read.includes('order_other'));
 checks.push('Event metrics can self-publish dataset schema and ingest; schema conflicts roll back metric and grants.');
 const saved=await create('referenced');
 await call('POST','metrics/library',{name:'Saved reference',kind:'query',visibility:'private',config:{query:{period:'today',compare:false,query:{metricId:saved.metric.id,interval:'day'}}}});
 await del('referenced',a.token,1,409);checks.push('Saved query references block deletion.');
 // Two requests can authenticate against the same initial revision and still get serialized.
 await create('racing');
 const results=await Promise.all([call('DELETE','metrics/definitions/racing',{expectedRevision:1},a.token,[200,409]),call('POST','metrics/measurements',point('racing'),a.token,[202,404])]);
 assert.equal(results.filter(r=>!r.error).length,1);
 const remaining=(await pool.query("SELECT id FROM metrics WHERE key='racing'")).rows[0];
 if(remaining)assert.equal((await pool.query('SELECT has_data FROM metric_registrations WHERE metric_id=$1',[remaining.id])).rows[0].has_data,true);
 else assert.equal((await pool.query("SELECT count(*) n FROM metric_record_keys WHERE payload::text LIKE '%racing-one%'")).rows[0].n,'0');
 checks.push('Concurrent ingestion versus deletion has one winner; accepted records never lose their definition.');
 // Management retries do not restore read/write access removed by an administrator.
 await create('restricted_retry');
 let restricted=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);
 await call('POST','integrations',{action:'update',...restricted,permissions:{...restricted.permissions,metrics:{...restricted.permissions.metrics,read:restricted.permissions.metrics.read.filter((k:string)=>k!=='restricted_retry'),write:restricted.permissions.metrics.write.filter((k:string)=>k!=='restricted_retry')}}});
 await call('POST','metrics/definitions',spec('restricted_retry'),a.token);
 await call('GET','metrics/definition/restricted_retry',undefined,a.token,404);
 await call('POST','metrics/measurements',point('restricted_retry'),a.token,404);
 await del('restricted_retry',a.token);
 // Scope restrictions on keys granted before definition creation must survive auto-grants.
 restricted=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);
 await call('POST','integrations',{action:'update',...restricted,permissions:{...restricted.permissions,metrics:{...restricted.permissions.metrics,read:[...restricted.permissions.metrics.read,'scoped_auto'],dimensions:{scoped_auto:{region:'BR'}}}}});
 await create('scoped_auto');
 await call('POST','metrics/measurements',{measurements:[{...point('scoped_auto').measurements[0],dimensions:{region:'US'}}]},a.token,403);
 await del('scoped_auto',a.token);
 checks.push('Startup retries never restore removed grants; pre-granted dimension scopes are preserved.');
 // Ordinary grants do not confer ownership; turning off management does not revoke data grants.
 settings=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===a.id);
 await call('POST','integrations',{action:'update',...settings,permissions:{...settings.permissions,metrics:{...settings.permissions.metrics,manageOwn:false}}});
 await call('POST','metrics/definitions',spec('new_denied'),a.token,403);
 await call('PATCH','metrics/definitions/revenue',{expectedRevision:2,changes:{name:'Denied'}},a.token,403);await del('revenue',a.token,2,403);
 assert.equal(Number((await call('POST','metrics/query',query,a.token)).value),23.45);
 const other=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===b.id);
 await call('POST','integrations',{action:'update',...other,permissions:{...grants,metrics:{...grants.metrics,read:['revenue'],write:['revenue']}}});
 await call('GET','metrics/definition/revenue',undefined,b.token);await call('PATCH','metrics/definitions/revenue',{expectedRevision:2,changes:{name:'Not owner'}},b.token,404);
 checks.push('Disabling management takes effect without revoking data access; explicit read/write grants never confer ownership.');
 // No implicit adoption of metrics created by a human, even for this publisher.
 await call('POST','metrics/definitions',{definition:{...spec('human_metric').definition,sourceId:other.source_id}});
 await call('PATCH','metrics/definitions/human_metric',{expectedRevision:1,changes:{name:'Adopted'}},b.token,404);
 await call('POST','integrations',{action:'revoke',id:b.id,credentialId:(await call('GET','integrations')).credentials.find((x:{app_id:string})=>x.app_id===b.id).id});
 await call('POST','metrics/definitions',spec('revoked'),b.token,401);
 checks.push('Human definitions are not silently adopted and revoked credentials cannot self-publish.');
 const full=await app('At grant budget');const atLimit=(await call('GET','integrations')).apps.find((x:{id:string})=>x.id===full.id);
 const fullKeys=Array.from({length:500},(_,i)=>'reserved_'+i);
 await call('POST','integrations',{action:'update',...atLimit,permissions:{...grants,metrics:{...grants.metrics,read:fullKeys}}});
 await call('POST','metrics/definitions',spec('over_budget'),full.token,422);
 assert.equal((await pool.query("SELECT count(*) n FROM metrics WHERE key='over_budget'")).rows[0].n,'0');
 assert.equal((await pool.query('SELECT revision FROM warehouse_apps WHERE id=$1',[full.id])).rows[0].revision,2);
 checks.push('Grant-budget exhaustion rejects registration atomically without changing metrics or integration revision.');
 await mkdir('experiments',{recursive:true});await writeFile('experiments/metric-management-acceptance.json',JSON.stringify({at:new Date().toISOString(),passed:checks.length,checks},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{await(await database()).end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
