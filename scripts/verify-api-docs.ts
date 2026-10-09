// Exercises the actual JSON examples in the public guides through the HTTP handlers.
// Provider calls are disabled; all data and credentials belong to an isolated schema.
delete process.env.VOYAGE_API_KEY;
import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const metrics=await readFile('docs/metrics-api.md','utf8'),knowledge=await readFile('docs/knowledge-api.md','utf8');
const examples=new Map<string,Record<string,unknown>>();
for(const markdown of [metrics,knowledge,await readFile('docs/integrations.md','utf8')]){
 for(const block of markdown.matchAll(/```json\n([\s\S]*?)\n```/g))JSON.parse(block[1]);
 for(const match of markdown.matchAll(/<!-- example: ([\w-]+) -->\n```json\n([\s\S]*?)\n```/g))examples.set(match[1],JSON.parse(match[2]));
}
const checks:string[]=['Every JSON block parses'];
const base=new Date();base.setUTCHours(0,0,0,0);base.setUTCDate(base.getUTCDate()-1);
function example(name:string,replacements:Record<string,string>={}){
 assert.ok(examples.has(name),name);let value=JSON.stringify(examples.get(name));
 // Keep the guide's local-clock semantics, moving its historical fixture into retention.
 value=value.replace(/2026-10-(07|08|09)/g,(_,day)=>new Date(base.getTime()+(Number(day)-8)*86400000).toISOString().slice(0,10));
 for(const [from,to]of Object.entries(replacements))value=value.replaceAll(from,to);
 return JSON.parse(value);
}
const url=new URL(process.env.DATABASE_URL!),schema='warehouse_docs_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.WAREHOUSE_ACCESS='local';
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');
async function call(path:string,body?:unknown,token?:string,status=200){const headers:Record<string,string>={};if(token)headers.Authorization='Bearer '+token;if(body)headers['Content-Type']='application/json';const response=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('?')[0].split('/')})});const result=await response.json();assert.equal(response.status,status,`${path}: ${JSON.stringify(result)}`);return result;}
try{
 await call('session');const pool=await database();
 const kinds=[
 ['sales_revenue_brl','sum','BRL','channel','measurements'],['orders_received','count','orders','channel','measurements'],['request_duration_ms','mean','ms','service','measurements'],['queue_peak','max','jobs','service','measurements'],
 ['campaign_conversion_rate','ratio','ratio','campaign_id','measurements'],['service_uptime','ratio','ratio','service','measurements'],['campaign_cpc_brl','ratio','BRL/click','campaign_id','measurements'],
 ['room_temperature_min','min','C','room','measurements'],['unique_visitors','distinct','visitors','campaign_id','measurements'],['request_duration_p95_ms','p95','ms','service','measurements'],
 ['ad_spend_brl','sum','BRL','campaign_id','aggregates'],['ad_impressions','count','impressions','campaign_id','aggregates'],['ad_duration_mean_ms','mean','ms','campaign_id','aggregates'],['ad_ctr','ratio','ratio','campaign_id','aggregates'],['ad_bid_min_brl','min','BRL','campaign_id','aggregates'],['ad_bid_max_brl','max','BRL','campaign_id','aggregates'],
 ['event_revenue_brl','sum','BRL','channel','events'],['event_orders','count','orders','channel','events'],['event_buyers','distinct','customers','channel','events']
 ];
 const keys=['cash_balance_brl',...kinds.map(r=>r[0])];
 await call('integrations',{action:'collection',key:'finance',name:'Finance'});
 const permissions={metrics:{read:keys,write:keys,dimensions:{},snapshots:true,export:true},knowledge:{readCollections:['finance'],writeCollections:['finance'],search:true,history:true,archive:true}};
 const app=await call('integrations',{action:'create',name:'API documentation fixtures',permissions});const token=(await call('integrations',{action:'issue',id:app.id,days:1})).secret;
 const sourceId=(await call('integrations')).apps.find((a:{id:string})=>a.id===app.id).source_id;
 const definition=example('balance-definition',{SOURCE_ID:sourceId});await call('metrics/definitions',definition);
 const policy=definition.definition.storagePolicy;
 for(const[key,kind,unit,dimension,inputMode]of kinds)await call('metrics/definitions',{definition:{key,name:key,kind,unit,sourceId,inputMode,timezone:'UTC',dimensions:[dimension],status:'active',...(!['distinct','p95'].includes(kind)?{storagePolicy:policy}:{}),...(inputMode==='events'?{datasetKey:'completed_orders',filters:{state:'completed'},valueField:'amount_brl',identityField:'customer_id'}:{})}});
 await call('metrics/datasets',example('order-dataset',{SOURCE_ID:sourceId}));
 for(const[name,endpoint]of [['balances','measurements'],['direct-kinds','measurements'],['ratios','measurements'],['raw-kinds','measurements'],['order-events','events'],['source-aggregates','aggregates']]){
  const receipt=await call('metrics/'+endpoint,example(name),token,202);assert.ok(receipt.accepted>0);while(await processMetricBatch(pool)){}
  assert.equal((await call('metrics/ingestions/'+receipt.id,undefined,token)).status,'completed');
 }
 checks.push('All nine kinds and three input modes: actual guide payloads accepted and published');
 const query=example('campaign-query');
 const q=(metricId:string)=>({metricId,startsAt:query.startsAt,endsAt:query.endsAt,interval:'hour'});
 const expectValue=async(key:string,value:number)=>assert.ok(Math.abs(Number((await call('metrics/query',q(key),token)).value)-value)<1e-8,key);
 for(const[key,value]of Object.entries({sales_revenue_brl:350,orders_received:1,request_duration_ms:200,queue_peak:19,campaign_conversion_rate:35/1100,service_uptime:3540/3600,campaign_cpc_brl:2.5,room_temperature_min:21.5,unique_visitors:2,request_duration_p95_ms:470,ad_spend_brl:120,ad_impressions:10000,ad_duration_mean_ms:300,ad_ctr:.0125,ad_bid_min_brl:.4,ad_bid_max_brl:2.1,event_revenue_brl:350,event_orders:2,event_buyers:1}))await expectValue(key,value);
 checks.push('Decimal totals, weighted ratios, means, minima/maxima, global distinct deduplication and interpolated p95 match guide arithmetic');
 assert.equal(Number((await call('metrics/query',example('balance-query'),token)).value),200000);
 assert.equal(Number((await call('metrics/query',example('account-query'),token)).value),125000.5);
 assert.equal(Number((await call('metrics/query',{...example('balance-query'),aggregation:'mean'},token)).value),100000);
 const closing=await call('metrics/query',example('daily-balance-query'),token);assert.equal(Number(closing.value),200000);assert.equal(closing.quality,'stale');assert.equal(closing.groups.length,2);
 const boundary=example('balance-query');assert.equal((await call('metrics/query',{...boundary,startsAt:new Date(Date.parse(boundary.startsAt)-3600000).toISOString(),endsAt:boundary.startsAt},token)).value,null);
 checks.push('Latest balance, single account, across-account mean, daily stale carry and exclusive boundary semantics');
 const compared=await call('metrics/query',query,token);assert.equal(Number(compared.value),10000);assert.equal(compared.groups.length,1);assert.equal(compared.comparison.value,null);
 const snapshot=await call('metrics/query',{...query,snapshot:true},token);assert.equal((await call('metrics/snapshots/'+snapshot.snapshotId,undefined,token)).result.value,compared.value);
 assert.equal((await call('metrics/export-query',query,token)).value,compared.value);
 assert.equal((await call('metrics/measurements',example('balances'),token,202)).duplicates,2);
 await call('metrics/coverage',example('sales-coverage'),token);assert.equal((await call('metrics/query',q('sales_revenue_brl'),token)).quality,'complete');
 checks.push('Comparisons, grouped results, saved snapshots, JSON exports, receipt deduplication and declared coverage');
 await call('metrics/corrections',example('balance-correction'),token,202);while(await processMetricBatch(pool)){}
 assert.equal(Number((await call('metrics/query',example('balance-query'),token)).value),201000);
 await call('metrics/corrections',example('balance-retraction'),token,202);while(await processMetricBatch(pool)){}
 assert.equal((await call('metrics/query',example('account-query'),token)).value,null);
 checks.push('Full replacement correction and next-revision tombstone');
 const doc=await call('knowledge/documents',example('knowledge-create'),token),vars={DOCUMENT_ID:doc.id};assert.equal(doc.revision,1);
 assert.equal((await call('knowledge/documents',example('knowledge-create'),token)).revision,1);
 assert.equal((await call('knowledge/documents?q=bank&collection=finance',undefined,token)).documents[0].id,doc.id);
 const updated=await call('knowledge/documents',example('knowledge-update',vars),token);assert.equal(updated.revision,2);
 assert.equal((await call('knowledge/documents',example('knowledge-update',vars),token)).revision,2);
 await call('knowledge/documents',{...example('knowledge-update',vars),content:'A competing stale edit'},token,409);
 assert.equal((await call('knowledge/documents/'+doc.id+'/history',undefined,token)).versions.length,2);
 const restored=await call('knowledge/documents',example('knowledge-restore',vars),token);assert.equal(restored.content,doc.content);assert.equal(restored.revision,3);
 const archived=await call('knowledge/documents',example('knowledge-archive',vars),token);assert.equal(archived.revision,4);assert.equal(archived.active,false);
 assert.equal((await call('knowledge/documents?collection=finance',undefined,token)).documents.length,0);
 assert.equal((await call('knowledge/documents/'+doc.id,undefined,token)).active,false);
 checks.push('Guide document CRUD workflow: create, retry, search, optimistic conflict, history, restore and reversible archive');
 await call('integrations',{action:'collection',key:'warehouse',name:'Warehouse'});
 for(const key of ['warehouse.architecture','warehouse.deployment','unrelated-note'])await call('knowledge/documents',{collection:'warehouse',key,title:key,content:'Existing document'});
 const importer=spawnSync(process.execPath,['--import','tsx','scripts/import-knowledge.ts'],{env:process.env,cwd:process.cwd(),encoding:'utf8'});assert.equal(importer.status,0,importer.stderr);assert.match(importer.stdout,/Imported 3 documents; archived 2/);
 const active=(await call('knowledge/documents?collection=warehouse')).documents.map((d:{key:string})=>d.key);
 assert.deepEqual(active.sort(),['unrelated-note','warehouse.integrations','warehouse.knowledge-api','warehouse.metrics-api'].sort());
 const again=spawnSync(process.execPath,['--import','tsx','scripts/import-knowledge.ts'],{env:process.env,cwd:process.cwd(),encoding:'utf8'});assert.equal(again.status,0,again.stderr);assert.match(again.stdout,/archived 0/);
 assert.equal((await pool.query("SELECT max(revision) revision FROM knowledge_documents WHERE key IN ('warehouse.integrations','warehouse.knowledge-api','warehouse.metrics-api')")).rows[0].revision,1);
 checks.push('Bundled importer archives only two explicit retired keys, preserves unrelated content and is idempotent');
 await mkdir('experiments',{recursive:true});const report={at:new Date().toISOString(),passed:checks.length,examples:examples.size,metrics:keys.length,checks,scope:'Isolated PostgreSQL schema; guide fixture dates shifted together into current retention; no external provider calls'};await writeFile('experiments/api-docs-acceptance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await(await database()).end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
