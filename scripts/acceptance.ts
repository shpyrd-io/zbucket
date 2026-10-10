// Acceptance uses synthetic provider fixtures even when local Voyage is enabled.
delete process.env.VOYAGE_API_KEY;
import pg from 'pg';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL!),schema='warehouse_test_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.WAREHOUSE_ACCESS='local';
const {GET,POST}=await import('../app/api/v1/[...operation]/route');const {database}=await import('../src/server/database');const {processMetricBatch}=await import('../src/server/metrics/worker');const {indexOne}=await import('../src/server/knowledge');
const checks:string[]=[];
async function call(path:string,body?:unknown,token?:string,status=200){const headers:Record<string,string>={};if(token)headers.Authorization='Bearer '+token;if(body)headers['Content-Type']='application/json';const r=await(body?POST:GET)(new Request('http://localhost/api/v1/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}),{params:Promise.resolve({operation:path.split('?')[0].split('/')})});const value=await r.json();assert.equal(r.status,status,`${path}: ${JSON.stringify(value)}`);return value;}
const deny={metrics:{read:[],write:[],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
try{
 await call('session');const pool=await database();
 await call('integrations',{action:'collection',key:'private',name:'Private CRM'});
 const grants={metrics:{read:['cash_balance_brl'],write:['cash_balance_brl'],dimensions:{},snapshots:true},knowledge:{readCollections:['general'],writeCollections:['general'],search:true,history:true,archive:true}};
 const tower=await call('integrations',{action:'create',name:'Control Tower',permissions:grants});
 const r=await call('integrations',{action:'issue',id:tower.id,days:30});const token=r.secret;assert.ok(token.startsWith('wh_'));
 const settings=await call('integrations'),app=settings.apps.find((a:{id:string})=>a.id===tower.id);
 assert.equal((await pool.query('SELECT count(*) n FROM warehouse_credentials')).rows[0].n,'1');
 await call('metrics/sources',undefined,token,403);
 const metric=await call('metrics/definitions',{definition:{key:'cash_balance_brl',name:'Cash balance',kind:'latest',unit:'BRL',sourceId:app.source_id,inputMode:'measurements',dimensions:['account_id'],status:'active',timezone:'UTC',missingData:'keep_previous',storagePolicy:{baseResolution:'hour',baseRetentionDays:30,hourRetentionDays:30,dayRetentionDays:730,rawRetentionDays:null}}});
 const measurement=(id:string,account:string,value:string)=>({measurementId:id,metricKey:metric.key,observedAt:'2026-10-08T10:00:00Z',value,unit:'BRL',dimensions:{account_id:account}});
 const receipt=await call('metrics/measurements',{measurements:[measurement('one','one','125000.50'),measurement('two','two','74999.50')]},token,202);assert.equal(receipt.accepted,2);
 assert.equal((await call('metrics/measurements',{measurements:[measurement('one','one','125000.50')]},token,202)).duplicates,1);
 await processMetricBatch(pool);assert.equal((await call('metrics/ingestions/'+receipt.id,undefined,token)).status,'completed');
 const q={metricId:metric.key,startsAt:'2026-10-08T00:00:00Z',endsAt:'2026-10-09T00:00:00Z',interval:'hour',aggregation:'sum'};
 assert.equal(Number((await call('metrics/query',q,token)).value),200000);
 for(const credential of [undefined,token]){
  await call('metrics/exports',q,credential,404);
  await call('metrics/export-query',q,credential,404);
  await call('metrics/exports/'+receipt.id,undefined,credential,404);
  await call('metrics/exports/'+receipt.id+'/download',undefined,credential,404);
 }
 assert.equal((await pool.query("SELECT to_regclass($1) AS name",[schema+'.metric_exports'])).rows[0].name,null);
 checks.push('Removed export creation, status, download and JSON attachment endpoints return 404 for users and integrations; no export queue is created');
 const doc=await call('knowledge/documents',{collection:'general',key:'tower/cash',title:'Cash balance integration',content:'# Cash balances\n\nCollect bank snapshots every hour.',tags:['banking']},token);
 assert.equal((await call('knowledge/documents/'+doc.id,undefined,token)).revision,1);
 checks.push('One integration credential publishes metrics and documents, reads data and receipts; no separate producer secret');
 const duplicate=await call('knowledge/documents',{collection:'general',key:'tower/cash',title:doc.title,content:doc.content,tags:doc.tags},token);assert.equal(duplicate.revision,1);
 const edited=await call('knowledge/documents',{id:doc.id,revision:1,title:doc.title,content:'# Cash balances\n\nNew banking instructions.',tags:doc.tags},token);assert.equal(edited.revision,2);
 await call('knowledge/documents',{id:doc.id,revision:1,title:doc.title,content:'Stale change'},token,409);
 assert.equal((await call('knowledge/documents/'+doc.id+'/history',undefined,token)).versions.length,2);
 const restored=await call('knowledge/documents',{id:doc.id,revision:2,action:'restore',restoreRevision:1},token);assert.equal(restored.content,doc.content);assert.equal(restored.revision,3);
 const originalKey=process.env.VOYAGE_API_KEY;delete process.env.VOYAGE_API_KEY;
 assert.equal((await call('knowledge/documents?q=bank',undefined,token)).documents[0].id,doc.id);
 await indexOne(pool,async texts=>texts.map(()=>Array(1024).fill(.01)));assert.equal((await pool.query('SELECT index_status FROM knowledge_documents WHERE id=$1',[doc.id])).rows[0].index_status,'indexed');
 if(originalKey)process.env.VOYAGE_API_KEY=originalKey;
 checks.push('Document retries, optimistic revisions, restore, immediate text search and vector indexing with deterministic fixture');
 await call('metrics/definitions/'+metric.id,{expectedRevision:1,definition:{name:'Cash at banks'}});assert.equal(Number((await call('metrics/query',q,token)).value),200000);
 await call('metrics/definitions/'+metric.id,{expectedRevision:2,definition:{unit:'USD'}},undefined,409);checks.push('Immutable metric contract and metadata edits retain measurements');
 const readerGrants={...grants,metrics:{...grants.metrics,write:[],dimensions:{cash_balance_brl:{account_id:'one'}}},knowledge:{...grants.knowledge,writeCollections:[]}};
 const reader=await call('integrations',{action:'create',name:'Reporting app',permissions:readerGrants});const readerToken=(await call('integrations',{action:'issue',id:reader.id,days:30})).secret;
 assert.equal(Number((await call('metrics/query',q,readerToken)).value),125000.5);await call('metrics/query',{...q,dimensions:{account_id:'two'}},readerToken,403);
 await call('metrics/measurements',{measurements:[measurement('three','one','9')]},readerToken,403);
 await call('integrations',undefined,readerToken,403);await call('session',undefined,readerToken,403);await call('metrics/data/'+metric.id,undefined,readerToken,403);await call('metrics/ingestions/'+receipt.id,undefined,readerToken,404);
 await call('metrics/definitions',{definition:{}},readerToken,403);
 assert.equal((await pool.query('SELECT count(*) n FROM warehouse_users')).rows[0].n,'1');checks.push('Dimension-scoped reader cannot write, escape scope, inspect another receipt, manage integrations or create human users');
 await call('knowledge/documents',{collection:'private',key:'crm/private',title:'Private customers',content:'Secret CRM context.'});
 assert.equal((await call('knowledge/documents?q=Secret',undefined,readerToken)).documents.length,0);await call('knowledge/documents',{collection:'private',key:'escape',title:'Escaped',content:'Not allowed'},token,403);
 const foreign=await call('integrations',{action:'create',name:'CRM',permissions:grants});const foreignToken=(await call('integrations',{action:'issue',id:foreign.id,days:30})).secret;
 await call('knowledge/documents',{id:doc.id,revision:3,title:'Overwrite',content:'Foreign publisher'},foreignToken,403);await call('metrics/measurements',{measurements:[measurement('foreign','one','1')]},foreignToken,403);checks.push('Collection search and document ownership enforced; write grant cannot impersonate another metric publisher');
 const saved=await call('metrics/query',{...q,snapshot:true},token);
 await call('integrations',{action:'update',id:app.id,revision:1,name:app.name,permissions:{...grants,metrics:{...grants.metrics,dimensions:{cash_balance_brl:{account_id:'one'}}}}});await call('metrics/snapshots/'+saved.snapshotId,undefined,token,403);
 await call('metrics/query',{...q,snapshot:true},foreignToken);

 await call('metrics/corrections',{mode:'measurements',measurements:[{...measurement('two','one','20'),revision:2,reason:'Attempt to move outside-scope data'}]},token,403);
 await call('metrics/corrections',{mode:'measurements',recordId:'two',revision:2,tombstone:true,reason:'Attempt to remove outside-scope data'},token,403);
 assert.equal(Number((await call('metrics/query',q,readerToken)).value),125000.5);
 checks.push('Corrections and retractions authorize both old and new dimension scopes atomically');
 checks.push('Saved snapshots revalidate current scopes after permission narrowing');
 const rotated=await call('integrations',{action:'rotate',id:app.id,credentialId:r.id,days:30});await call('metrics/catalog',undefined,token,401);await call('metrics/catalog',undefined,rotated.secret);await call('integrations',{action:'revoke',id:app.id,credentialId:rotated.id});await call('metrics/catalog',undefined,rotated.secret,401);
 const expired=await call('integrations',{action:'issue',id:app.id,days:1});await pool.query("UPDATE warehouse_credentials SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await call('metrics/catalog',undefined,expired.secret,401);checks.push('Credential rotation, revocation and expiration');
 const none=await call('integrations',{action:'create',name:'No grants',permissions:deny}),noneToken=(await call('integrations',{action:'issue',id:none.id,days:1})).secret;assert.equal((await call('metrics/catalog',undefined,noneToken)).metrics.length,0);await call('metrics/query',q,noneToken,404);assert.equal((await call('knowledge/documents',undefined,noneToken)).documents.length,0);
 await pool.query('INSERT INTO warehouse_rate_limits VALUES($1,date_trunc(\'minute\',now()),240) ON CONFLICT(app_id) DO UPDATE SET requests=240',[none.id]);await call('metrics/catalog',undefined,noneToken,429);checks.push('Default-deny catalog/query/document access and application request quota');

 const eventKeys=['order_value','order_maximum'];
 const eventGrants={...grants,metrics:{...grants.metrics,read:eventKeys,write:[eventKeys[0]],dimensions:{}}};
 const eventApp=await call('integrations',{action:'create',name:'Event publisher',permissions:eventGrants});
 const eventToken=(await call('integrations',{action:'issue',id:eventApp.id,days:1})).secret;
 const eventSource=(await call('integrations')).apps.find((a:{id:string})=>a.id===eventApp.id).source_id;
 await call('metrics/datasets',{sourceId:eventSource,key:'orders',schema:{value:'decimal'}});
 for(const [i,key] of eventKeys.entries())await call('metrics/definitions',{definition:{key,name:key,kind:i?'max':'sum',sourceId:eventSource,inputMode:'events',datasetKey:'orders',unit:'BRL',dimensions:[],timezone:'UTC',status:'active',storagePolicy:{baseResolution:'hour',baseRetentionDays:30,hourRetentionDays:30,dayRetentionDays:730,rawRetentionDays:null}}});
 const eventBody={datasetKey:'orders',schemaVersion:1,events:[{eventId:'order-1',occurredAt:'2026-10-08T10:00:00Z',data:{value:'99.90'}}]};
 await call('metrics/events',eventBody,eventToken,404);
 assert.equal((await pool.query('SELECT count(*) n FROM metric_ingestions WHERE source_id=$1',[eventSource])).rows[0].n,'0');
 await call('integrations',{action:'update',id:eventApp.id,revision:1,name:'Event publisher',permissions:{...eventGrants,metrics:{...eventGrants.metrics,write:eventKeys}}});
 await call('metrics/events',eventBody,eventToken,202);while(await processMetricBatch(pool)){}
 for(const key of eventKeys)assert.equal(Number((await call('metrics/query',{...q,metricId:key,aggregation:undefined},eventToken)).value),99.9);
 checks.push('Event fanout checks every derived metric before accepting a batch and uses the same application credential');
 await call('metrics/catalog',undefined,'not-a-warehouse-token',401);
 const cross=await POST(new Request('http://localhost/api/v1/integrations',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({action:'collection',key:'forged',name:'Forged'})}),{params:Promise.resolve({operation:['integrations']})});assert.equal(cross.status,403);
 await call('integrations',{action:'update',id:eventApp.id,revision:2,name:'Event publisher',active:false,permissions:{...eventGrants,metrics:{...eventGrants.metrics,write:eventKeys}}});await call('metrics/catalog',undefined,eventToken,401);

 const inactive=await call('integrations',{action:'create',name:'Not enabled yet',active:false,permissions:deny});await call('integrations',{action:'issue',id:inactive.id,days:1},undefined,409);
 checks.push('Unknown bearer credentials, cross-origin administration and disabled integrations are rejected');
 let historyDoc=await call('knowledge/documents',{collection:'general',key:'test/history',title:'History retention',content:'Revision zero'});
 for(let i=0;i<24;i++)historyDoc=await call('knowledge/documents',{id:historyDoc.id,revision:historyDoc.revision,title:historyDoc.title,content:'Revision '+i});
 assert.equal((await call('knowledge/documents/'+historyDoc.id+'/history')).versions.length,21);
 await call('knowledge/documents',{id:historyDoc.id,revision:historyDoc.revision,action:'archive'});
 assert.equal((await call('knowledge/documents?q=History')).documents.some((d:{id:string})=>d.id===historyDoc.id),false);
 checks.push('Document history retains current plus 20 revisions; archived content is removed from discovery');
 await mkdir('experiments',{recursive:true});const report={at:new Date().toISOString(),passed:checks.length,checks,scope:'isolated synthetic schema',providers:'no real provider calls'};await writeFile('experiments/acceptance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await (await database()).end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
