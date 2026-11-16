// Add daily metrics and reusable reports to a previously collected local browser demo.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:4332';
const demo=JSON.parse(await readFile('experiments/metrics/app-demo/data.json','utf8'));
async function call(path:string,body?:unknown){const r=await fetch(origin+'/api/v1/metrics/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;}
const scope=demo.scope,day=(value:string)=>value.slice(0,10)+'T00:00:00.000Z';
const {metric}=await call('event-processing',{...scope,key:'orbit_daily_events',name:'Orbit · Daily app events',includeHistory:true});
let job;for(let attempt=0;attempt<60;attempt++){job=(await call('event-processing')).jobs.find((j:{metric_id:string})=>j.metric_id===metric.id);if(job.status==='completed')break;await new Promise(r=>setTimeout(r,1000));}assert.equal(job.status,'completed','Run the Warehouse worker to finish processing history.');assert.equal(Number(job.inserted),25);
const dailyQuery={metricId:metric.id,startsAt:day(scope.startsAt),endsAt:day(scope.endsAt),interval:'day',groupBy:['name']};
const daily=await call('query',dailyQuery);assert.equal(Number(daily.value),25);
const existing=await call('library');
async function save(name:string,kind:string,config:unknown){return existing.find((i:{name:string})=>i.name===name)??await call('library',{name,kind,visibility:'company',config});}
const funnelQuery=await save('Orbit · Activation funnel','query',{eventFunnel:{query:{...scope,unit:'person',windowSeconds:86400,steps:['app_opened','signup_completed','feature_used','report_exported'].map(name=>({name}))},period:'fixed'},chart:{kind:'funnel',stageTotals:true,orientation:'horizontal'}});
const funnelView=await save('Orbit · Conversion','view',{queryIds:[funnelQuery.id],chart:{kind:'funnel',stageTotals:true,orientation:'horizontal'}});
const volumeQuery=await save('Orbit · Events per day','query',{query:{query:dailyQuery,period:'fixed',compare:false},chart:{kind:'bar'}});
const volumeView=await save('Orbit · Daily activity','view',{queryIds:[volumeQuery.id],chart:{kind:'bar'}});
const dashboard=await save('Orbit · Product analytics','dashboard',{viewIds:[funnelView.id,volumeView.id],layout:'list'});
const result=await call('library-run',{id:dashboard.id});assert(result.panels.every((p:{error?:string})=>!p.error));assert.deepEqual(result.panels[0].data.rows.map((r:{value:string})=>r.value),['10','7','5','3']);
const report={metric,job,daily,funnelQueryId:funnelQuery.id,dashboardId:dashboard.id,dashboardUrl:origin+'/metrics?workspace=studio&item='+dashboard.id,metricUrl:origin+'/metrics/'+metric.id,result};await writeFile('experiments/metrics/app-demo/reporting.json',JSON.stringify(report,null,2));console.log(JSON.stringify({metricUrl:report.metricUrl,dashboardUrl:report.dashboardUrl,history:job.status,events:daily.value,funnel:result.panels[0].data.rows.map((r:{value:string})=>r.value)}));
