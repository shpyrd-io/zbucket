// Local-only fictional application. Run after `npm run dev`.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createAnalyticsRelay,browserDatasetSchema,browserEventMapping} from '../../sdk/javascript/src/relay.ts';
import {ZbucketClient} from '../../sdk/javascript/src/server.ts';
const zbucketUrl='http://127.0.0.1:4332',origin='http://127.0.0.1:4333';
async function api(path,body){const r=await fetch(zbucketUrl+'/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;}
const datasetKey='app_demo',run=new Date().toISOString();
const app=await api('integrations',{action:'create',name:'Demo app · '+run,permissions:{metrics:{read:[],write:[],eventRead:[datasetKey],eventWrite:[datasetKey],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}}});
const token=(await api('integrations',{action:'issue',id:app.id})).secret;
const sourceId=(await api('integrations')).apps.find(a=>a.id===app.id).source_id;
await api('metrics/datasets',{sourceId,key:datasetKey,schema:browserDatasetSchema});
await api('metrics/event-datasets',{sourceId,datasetKey,schemaVersion:1,mapping:browserEventMapping,retentionDays:30});
const sessions=new Map(),statuses=[];let requests=0,windowStart=Date.now();
const session=req=>sessions.get(/demo_session=([^;]+)/.exec(req.headers.get('cookie')||'')?.[1]);
const relay=createAnalyticsRelay({client:new ZbucketClient(zbucketUrl,token),datasetKey,schemaVersion:1,origin,signingSecret:randomUUID()+randomUUID(),resolveIdentity:async req=>session(req)||null,allowRequest:async()=>{if(Date.now()-windowStart>60000){windowStart=Date.now();requests=0;}return ++requests<=300;}});
const scope={sourceId,datasetKey,schemaVersion:1,startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString()};
const server=createServer(async(req,res)=>{try{
 const parts=[];for await(const part of req)parts.push(part);
 const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(parts)}:{})});let response;
 if(req.url==='/analytics/events'){response=await relay(request);statuses.push({path:req.url,status:response.status});}
 else if(req.url==='/demo/session'&&req.method==='POST'){
  if(request.headers.get('origin')!==origin){response=new Response('Origin denied',{status:403});}
  else {const {person}=await request.json();if(person!==null&&(!Number.isInteger(person)||person<1||person>10))throw new Error('Invalid demo person');const id=randomUUID();sessions.set(id,person===null?null:{userId:'person-'+person,accountId:'acme-'+person});response=Response.json({ok:true},{headers:{'Set-Cookie':`demo_session=${id}; Path=/; HttpOnly; SameSite=Lax`}});}
 }else if(req.url==='/demo/report'){
  const timeline=await api('metrics/event-timeline',{...scope,userId:'user:person-1'}),account=await api('metrics/event-timeline',{...scope,accountId:'acme-1'}),all=await api('metrics/event-timeline',{...scope,limit:100}),funnel=await api('metrics/event-funnel',{...scope,unit:'person',windowSeconds:86400,steps:['app_opened','signup_completed','feature_used','report_exported'].map(name=>({name}))});
  const report={fictional:true,run,scope,transport:'Real browser SDK → same-origin relay → zbucket HTTP API → PostgreSQL worker',statuses,eventCount:all.events.length,funnel,personTimeline:timeline,accountTimeline:account,events:all.events};
  if(all.events.length===25){assert.deepEqual(funnel.steps.map(s=>s.count),[10,7,5,3]);await writeFile('experiments/metrics/app-demo/data.json',JSON.stringify(report,null,2));}
  response=Response.json(report);
 }else if(req.url==='/sdk.js'){response=new Response(await readFile('public/sdk/zbucket-0.1.0.js'),{headers:{'Content-Type':'text/javascript'}});}
 else if(req.url==='/'){response=new Response(await readFile('examples/analytics-demo/index.html'),{headers:{'Content-Type':'text/html'}});}
 else response=new Response('Not found',{status:404});
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){console.error(String(error));res.writeHead(500);res.end('Demo request failed');}});
server.listen(4333,'127.0.0.1',()=>console.log(JSON.stringify({app:origin,zbucket:zbucketUrl+'/metrics/events',sourceId,datasetKey})));
