import pg from 'pg';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
delete process.env.VOYAGE_API_KEY;
const url=new URL(process.env.DATABASE_URL!),schema='events_test_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.ZBUCKET_ACCESS='local';
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');const {maintainMetricRetention}=await import('../src/server/metrics/rollups');
const checks:string[]=[],timings:Record<string,number>={};let pool:pg.Pool|undefined;
async function call(path:string,body?:unknown,token?:string,status=200){const headers:Record<string,string>={};if(token)headers.Authorization='Bearer '+token;if(body)headers['Content-Type']='application/json';const r=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('?')[0].split('/')})});const value=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(value)}`);return value;}
const deny={metrics:{read:[],write:[],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
const base=Date.now()-3*86400000,at=(seconds:number)=>new Date(base+seconds*1000).toISOString();
try{
 await call('session');pool=await database();
 const grants={...deny,metrics:{...deny.metrics,eventRead:['behavior'],eventWrite:['behavior']}};
 const app=await call('integrations',{action:'create',name:'Behavior app',permissions:grants}),token=(await call('integrations',{action:'issue',id:app.id})).secret;
 const sourceId=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id).source_id;
 const dataset={sourceId,key:'behavior',schema:{action:'string',user:'string',account:'string',feature:'string'}};
 await call('metrics/datasets',dataset);
 const config={sourceId,datasetKey:'behavior',schemaVersion:1,mapping:{name:'action',userId:'user',accountId:'account'},retentionDays:30};
 await call('metrics/event-datasets',config,token,403);await call('metrics/event-datasets',config);await call('metrics/event-datasets',config);
 await call('metrics/event-datasets',{...config,retentionDays:31},undefined,409);
 const scope={sourceId,datasetKey:'behavior',schemaVersion:1,startsAt:at(-1),endsAt:at(10000)};
 const event=(id:string,action:string,seconds:number,user='ana',account='acme')=>({eventId:id,occurredAt:at(seconds),data:{action,user,account,feature:'export'}});
 const body={datasetKey:'behavior',schemaVersion:1,events:[event('1','open',0),event('2','signup',10),event('3','use',20,'bruno'),event('4','open',30,'carla','beta')]};
 const receipt=await call('metrics/events',body,token,202);assert.equal(receipt.accepted,4);
 assert.equal((await call('metrics/event-timeline',scope,token)).recomputing,true);
 await assert.rejects(()=>processMetricBatch(pool!,1000,true));assert.equal((await pool.query('SELECT count(*) n FROM metric_event_index')).rows[0].n,'0');
 await Promise.all([processMetricBatch(pool,2),processMetricBatch(pool,2)]);while(await processMetricBatch(pool)){}
 assert.equal((await call('metrics/events',body,token,202)).duplicates,4);
 assert.equal((await call('metrics/event-timeline',scope,token)).events.length,4);
 checks.push('Existing events endpoint accepts event-only datasets; durable retries and publication rollback preserve one event');
 const noAccess=await call('integrations',{action:'create',name:'No events',permissions:deny}),other=(await call('integrations',{action:'issue',id:noAccess.id})).secret;
 await call('metrics/event-timeline',scope,other,403);await call('metrics/event-funnel',{...scope,steps:[{name:'open'},{name:'use'}]},other,403);
 assert.equal((await call('metrics/event-datasets',undefined,other)).datasets.length,0);
 await call('metrics/event-timeline',{...scope,sourceId:noAccess.id},token,403);
 const appState=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 await call('integrations',{action:'update',id:app.id,revision:appState.revision,name:appState.name,permissions:{...grants,metrics:{...grants.metrics,eventWrite:[]}}});
 await call('metrics/events',{...body,events:[event('denied','open',40)]},token,403);
 await call('metrics/events',{...body,datasetKey:' behavior ',mode:'measurements',events:[event('spoofed','open',40)]},token,403);
 await call('integrations',{action:'update',id:app.id,revision:appState.revision+1,name:appState.name,permissions:grants});
 checks.push('Default deny, own-source isolation, independent dataset grants and permission narrowing');
 for(let attempt=0;attempt<8;attempt++){await pool.query("UPDATE metric_event_datasets SET backfilled=false,cursor_at='-infinity',cursor_id='',cursor_revision=0 WHERE source_id=$1",[sourceId]);await Promise.all([processMetricBatch(pool,1),processMetricBatch(pool,1)]);while(await processMetricBatch(pool,2)){} }
 assert.equal((await pool.query('SELECT count(*) n FROM metric_event_index')).rows[0].n,'4');
 const page=await call('metrics/event-timeline',{...scope,accountId:'acme',limit:2},token);assert.deepEqual(page.events.map((e:{eventId:string})=>e.eventId),['3','2']);
 const next=await call('metrics/event-timeline',{...scope,accountId:'acme',limit:2,after:page.nextCursor},token);assert.deepEqual(next.events.map((e:{eventId:string})=>e.eventId),['1']);assert.equal(next.nextCursor,null);
 const funnel={...scope,steps:[{name:'open'},{name:'signup'},{name:'use'}],windowSeconds:60};
 assert.deepEqual((await call('metrics/event-funnel',{...funnel,unit:'account'},token)).steps.map((s:{count:number})=>s.count),[2,1,1]);
 assert.deepEqual((await call('metrics/event-funnel',{...funnel,unit:'person'},token)).steps.map((s:{count:number})=>s.count),[2,1,0]);
 assert.equal((await call('metrics/event-funnel',{...funnel,unit:'account',steps:[{name:'open'},{name:'use',properties:{feature:'export'}}]},token)).steps[1].count,1);
 assert.equal((await call('metrics/event-funnel',{...funnel,unit:'account',steps:[{name:'open'},{name:'use',properties:{feature:'import'}}]},token)).steps[1].count,0);
 assert.deepEqual((await call('metrics/event-funnel',{...funnel,unit:'account',stage:1,outcome:'dropped'},token)).participants,[{id:'beta',reached:1}]);
 checks.push('Timeline keyset pagination, event properties, account versus person funnels and abandonment drilldown');
 await call('metrics/corrections',{...body,mode:'events',events:[{...event('3','use',20,'bruno','beta'),revision:2}]},token,202);while(await processMetricBatch(pool)){}
 assert.equal((await call('metrics/event-timeline',{...scope,accountId:'acme'},token)).events.length,2);
 assert.equal((await call('metrics/event-funnel',{...funnel,unit:'account'},token)).steps[2].count,0);
 await call('metrics/corrections',{mode:'events',tombstone:true,recordId:'3',revision:3,reason:'Synthetic deletion'},token,202);while(await processMetricBatch(pool)){}
 assert.equal((await call('metrics/event-timeline',{...scope,accountId:'beta'},token)).events.length,1);
 checks.push('Corrections move account histories and recompute funnels; retractions remove indexed occurrences');
 // Legacy event records are backfilled from the same original and continue to feed metrics.
 await call('metrics/datasets',{...dataset,key:'legacy'});
 const metric=await call('metrics/definitions',{definition:{key:'legacy_count',name:'Legacy events',sourceId,inputMode:'events',datasetKey:'legacy',kind:'count',unit:'events',dimensions:[],status:'active',timezone:'UTC',storagePolicy:{baseResolution:'hour',baseRetentionDays:30,hourRetentionDays:30,dayRetentionDays:730,rawRetentionDays:1}}});
 const state=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 const legacyGrants={...grants,metrics:{...grants.metrics,read:['legacy_count'],write:['legacy_count'],eventRead:['behavior','legacy'],eventWrite:['behavior','legacy']}};
 await call('integrations',{action:'update',id:app.id,revision:state.revision,name:state.name,permissions:legacyGrants});
 await call('metrics/events',{...body,datasetKey:'legacy',events:[event('legacy-1','open',0),event('legacy-2','open',-0.5),event('legacy-3','open',-0.7)]},token,202);while(await processMetricBatch(pool)){}
 await call('metrics/events',{...body,datasetKey:'legacy',events:[event('legacy-pending','open',0,'x'.repeat(201))]},token,202);
 await call('metrics/event-datasets',{...config,datasetKey:'legacy'});
 let passes=0;while(await processMetricBatch(pool,1)){assert.ok(++passes<10,'Backfill must advance through microsecond receipt timestamps');}
 assert.equal((await call('metrics/event-datasets',undefined,token)).datasets.find((d:{datasetKey:string})=>d.datasetKey==='legacy').skippedRecords,1);
 await maintainMetricRetention(pool);
 assert.equal((await call('metrics/event-timeline',{...scope,datasetKey:'legacy'},token)).events[0].eventId,'legacy-1');
 assert.equal((await pool.query('SELECT count(*) n FROM metric_facts WHERE metric_id=$1',[metric.id])).rows[0].n,'0');
 assert.ok((await pool.query("SELECT payload->'original' AS original FROM metric_record_keys WHERE record_id='legacy-1'")).rows[0].original);
 checks.push('Backfill retained originals with microsecond cursors; skip incompatible pre-configuration work without blocking; preserve timeline when metric raw retention expires');
 // Event-only expiry keeps deduplication hashes and cannot be revived by corrections.
 await call('metrics/datasets',{...dataset,key:'short'});await call('metrics/event-datasets',{...config,datasetKey:'short',retentionDays:1});
 const again=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 await call('integrations',{action:'update',id:app.id,revision:again.revision,name:again.name,permissions:{...legacyGrants,metrics:{...legacyGrants.metrics,eventRead:['behavior','legacy','short'],eventWrite:['behavior','legacy','short']}}});
 const expired={...body,datasetKey:'short',events:[event('expired','open',0)]};await call('metrics/events',expired,token,202);while(await processMetricBatch(pool)){}
 await pool.query("UPDATE metric_record_keys SET received_at=now()-interval '3 days' WHERE record_id='expired'");await maintainMetricRetention(pool);
 assert.equal((await call('metrics/events',expired,token,202)).duplicates,1);
 await call('metrics/corrections',{...expired,mode:'events',events:[{...expired.events[0],revision:2}]},token,409);
 checks.push('Independent event retention expires originals while preserving retry identities');
 // Bounded bulk publication smoke test, not a production throughput claim.
 const t=performance.now();await call('metrics/events',{...body,events:Array.from({length:1000},(_,i)=>event('bulk-'+i,'open',100+i,'person-'+i,'bulk'))},token,202);while(await processMetricBatch(pool)){}timings.ingestAndProcess1000Ms=performance.now()-t;
 const q=performance.now();assert.equal((await call('metrics/event-timeline',{...scope,accountId:'bulk',limit:100},token)).events.length,100);timings.timeline100Ms=performance.now()-q;
 await pool.query(`INSERT INTO metric_record_keys(source_id,record_id,revision,hash,ingestion_id,payload,processed)
 SELECT $1,'budget-'||i,1,'synthetic',$2,'{"projections":[],"original":{"record":{"data":{}}}}'::jsonb,true FROM generate_series(1,50001) i`,[sourceId,receipt.id]);
 await pool.query('ANALYZE metric_record_keys');
 for(let start=1;start<=50001;start+=1000)await pool.query(`INSERT INTO metric_event_index(source_id,record_id,revision,dataset_key,schema_version,occurred_at,name,account_id)
 SELECT $1,'budget-'||i,1,'behavior',1,$2,'budget','budget-account' FROM generate_series($3::int,$4::int) i`,[sourceId,at(100),start,Math.min(start+999,50001)]);
 await pool.query('ANALYZE metric_event_index');
 const oversized=await call('metrics/event-funnel',{...funnel,unit:'account',steps:[{name:'budget'},{name:'use'}]},token,422);assert.match(oversized.error,/50,000/);
 checks.push('Property-filtered funnel semantics and explicit rejection above the candidate budget');
 // Browser journey through the actual first-party relay and durable Events API.
 const {createAnalyticsRelay,browserDatasetSchema,browserEventMapping}=await import('../sdk/javascript/src/relay');
 const browserState=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id);
 await call('integrations',{action:'update',id:app.id,revision:browserState.revision,name:browserState.name,permissions:{...browserState.permissions,metrics:{...browserState.permissions.metrics,eventRead:[...browserState.permissions.metrics.eventRead,'web'],eventWrite:[...browserState.permissions.metrics.eventWrite,'web']}}});
 await call('metrics/datasets',{sourceId,key:'web',schema:browserDatasetSchema});
 await call('metrics/event-datasets',{sourceId,datasetKey:'web',schemaVersion:1,mapping:browserEventMapping,retentionDays:30});
 let signedIn=false;
 const relay=createAnalyticsRelay({origin:'https://app.example',signingSecret:'synthetic-test-signing-secret-only-123456',datasetKey:'web',schemaVersion:1,allowRequest:async()=>true,resolveIdentity:async()=>signedIn?{userId:'ana',accountId:'acme'}:null,client:{
  events:(datasetKey,schemaVersion,events)=>call('metrics/events',{datasetKey,schemaVersion,events},token,202),
  identifyEventPerson:(datasetKey,schemaVersion,anonymousId,userId)=>call('metrics/event-identify',{datasetKey,schemaVersion,anonymousId,userId},token)
 }});
 const relayCall=(body:unknown,cookie='')=>relay(new Request('https://app.example/analytics/events',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json',cookie},body:JSON.stringify(body)}));
 const anonymousResponse=await relayCall({action:'context'}),anonymous=await anonymousResponse.json(),cookie=anonymousResponse.headers.get('set-cookie')!.split(';')[0];
 const webAt=Date.now()-10000,webEvent=(name:string,context:unknown,i:number)=>({eventId:'web:'+crypto.randomUUID(),occurredAt:new Date(webAt+i*1000).toISOString(),name,context,sessionId:crypto.randomUUID(),properties:{feature:'reports',paid:true}});
 const before=webEvent('visited',anonymous,0);
 assert.equal((await relayCall({action:'capture',events:[before]})).status,202);
 signedIn=true;const identified=await(await relayCall({action:'context'},cookie)).json();
 const after=webEvent('signup',identified,1);assert.equal((await relayCall({action:'capture',events:[after]})).status,202);
 assert.equal((await relayCall({action:'capture',events:[before,after]})).status,202);
 while(await processMetricBatch(pool)){}
 const webScope={sourceId,datasetKey:'web',schemaVersion:1,startsAt:new Date(webAt-1000).toISOString(),endsAt:new Date(webAt+10000).toISOString()};
 const journey=await call('metrics/event-timeline',{...webScope,userId:'user:ana'},token);assert.equal(journey.events.length,2);assert.equal(journey.events[1].originalUserId,anonymous.anonymousId);assert.equal(journey.events[1].accountId,null);
 assert.equal((await call('metrics/event-timeline',{...webScope,accountId:'acme'},token)).events.length,1);
 const webFunnel=await call('metrics/event-funnel',{...webScope,steps:[{name:'visited'},{name:'signup',properties:{paid:true}}]},token);assert.deepEqual(webFunnel.steps.map((x:{count:number})=>x.count),[1,1]);
 assert.equal((await call('metrics/event-funnel',{...webScope,steps:[{name:'visited'},{name:'signup',properties:{missing:null}}]},token)).steps[1].count,0);
 await call('metrics/event-identify',{datasetKey:'web',schemaVersion:1,anonymousId:anonymous.anonymousId,userId:'user:other'},token,409);
 await call('metrics/event-identify',{datasetKey:'web',schemaVersion:1,anonymousId:anonymous.anonymousId,userId:'user:ana'},other,403);
 checks.push('Browser relay: anonymous visit, authenticated linking, typed properties, retries, person conversion and account-at-event timeline');
 // Resolve several anonymous aliases before paging, without attributing them to an account.
 const alias2='anon:'+crypto.randomUUID();await call('metrics/event-identify',{datasetKey:'web',schemaVersion:1,anonymousId:alias2,userId:'user:ana'},token);
 const additional=Array.from({length:8},(_,i)=>({eventId:'alias-page-'+i,occurredAt:new Date(webAt+2000).toISOString(),data:{name:'page',person:i%2?alias2:anonymous.anonymousId,account:null,session:'session',properties:{}}}));
 await call('metrics/events',{datasetKey:'web',schemaVersion:1,events:additional},token,202);while(await processMetricBatch(pool)){}
 let cursor:unknown;const ids:string[]=[];
 do{const page=await call('metrics/event-timeline',{...webScope,userId:'user:ana',limit:2,...(cursor?{after:cursor}:{})},token);ids.push(...page.events.map((e:{eventId:string})=>e.eventId));cursor=page.nextCursor;}while(cursor);
 assert.equal(ids.length,10);assert.equal(new Set(ids).size,10);assert.deepEqual(ids.slice(0,8),additional.map(e=>e.eventId).reverse());
 assert.equal((await call('metrics/event-timeline',{...webScope,userId:anonymous.anonymousId},token)).events.length,0);
 assert.equal((await call('metrics/event-timeline',{...webScope,userId:'user:ana',accountId:'acme'},token)).events.length,1);
 checks.push('Indexed person selection preserves alias merging, equal-time pagination, account filters and canonical identity semantics');
 // Event quotas remain per integration, distinct from reads and enforced across credentials.
 const appToken2=(await call('integrations',{action:'issue',id:app.id})).secret;
 await pool.query("INSERT INTO warehouse_event_rate_limits VALUES($1,date_trunc('minute',now()),2400,0) ON CONFLICT(app_id) DO UPDATE SET window_start=EXCLUDED.window_start,requests=2400,events=0",[app.id]);
 await call('metrics/events',{datasetKey:'web',schemaVersion:1,events:additional},appToken2,429);
 await call('metrics/event-identify',{datasetKey:'web',schemaVersion:1,anonymousId:alias2,userId:'user:ana'},token,429);
 await call('metrics/event-timeline',webScope,token);
 await pool.query("UPDATE warehouse_event_rate_limits SET requests=0,events=239992,window_start=date_trunc('minute',now()) WHERE app_id=$1",[app.id]);
 const bodyForQuota={datasetKey:'web',schemaVersion:1,events:additional};
 const requestQuota=(credential:string)=>POST(new Request('http://localhost/api/v1/metrics/events',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify(bodyForQuota)}),{params:Promise.resolve({operation:['metrics','events']})});
 const concurrent=await Promise.all([requestQuota(token),requestQuota(appToken2)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[202,429]);assert.equal(concurrent.find(r=>r.status===429)!.headers.get('retry-after'),'60');
 await pool.query("UPDATE warehouse_event_rate_limits SET window_start=now()-interval '1 minute' WHERE app_id=$1",[app.id]);
 assert.equal((await call('metrics/events',bodyForQuota,token,202)).duplicates,8);
 const quota=(await pool.query('SELECT requests,events FROM warehouse_event_rate_limits WHERE app_id=$1',[app.id])).rows[0];assert.deepEqual(quota,{requests:1,events:8});
 checks.push('Independent event request and volume quotas, concurrent admission, shared credentials and next-window recovery');
 await mkdir('experiments/metrics',{recursive:true});await writeFile('experiments/metrics/events-report.json',JSON.stringify({at:new Date().toISOString(),checks,timings,scope:'Isolated synthetic PostgreSQL schema; no production load claim'},null,2)+'\n');
 console.log(JSON.stringify({passed:checks.length,checks,timings},null,2));
}finally{await pool?.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
