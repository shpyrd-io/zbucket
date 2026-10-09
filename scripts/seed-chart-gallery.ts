/** Local, deterministic chart examples using the same ingestion/query path as applications. */
import assert from 'node:assert/strict';
import {database} from '../src/server/database';
import {authenticate} from '../src/server/access';
import {accessMode} from '../src/server/identity';
import {manageIntegration} from '../src/server/integrations';
import {saveDefinition,ingest,getMetric,coverage} from '../src/server/metrics/service';
import {processMetricBatch} from '../src/server/metrics/worker';
import {librarySave,libraryRun} from '../src/server/metrics/library';
import {chartKinds,chartIssue,type ChartOptions} from '../src/models/metrics/visualization';
import type {Metric,MetricQuery} from '../src/models/metrics/types';

assert.equal(accessMode(),'local','The chart gallery is a local demonstration only.');
const pool=await database();
try {
 assert.equal((await pool.query('select current_database() name')).rows[0].name,'shpyrd_warehouse','Use the local Warehouse database.');
 const actor=await authenticate(pool,new Request('http://localhost:4332/'));
 assert.equal(actor.kind,'user');
 const specs=[
  {key:'revenue',name:'Sales revenue',kind:'sum',unit:'USD',dimensions:['channel','region'],category:'Sales'},
  {key:'cash',name:'Cash balance',kind:'latest',unit:'USD',dimensions:['account'],category:'Finance'},
  {key:'latency',name:'Request duration',kind:'mean',unit:'ms',dimensions:[],category:'Engineering'},
  {key:'spend',name:'Campaign spend',kind:'sum',unit:'USD',dimensions:['region'],category:'Marketing'},
  {key:'leads',name:'Qualified leads',kind:'sum',unit:'leads',dimensions:['region'],category:'Marketing'},
  {key:'orders',name:'Orders',kind:'sum',unit:'orders',dimensions:['region'],category:'Sales'},
  {key:'score',name:'Team health score',kind:'latest',unit:'%',dimensions:['team'],category:'People'},
  {key:'health',name:'Service availability',kind:'latest',unit:'state',dimensions:['service'],category:'Engineering'},
  {key:'funnel',name:'Sales funnel stages',kind:'sum',unit:'prospects',dimensions:['stage'],category:'Sales'},
  {key:'profit',name:'Profit contributions',kind:'sum',unit:'USD',dimensions:['component'],category:'Finance'},
  {key:'goal',name:'Delivery on time',kind:'latest',unit:'%',dimensions:[],category:'Operations'},
 ];
 const keys=specs.map(s=>'gallery_'+s.key);
 let app=(await pool.query("SELECT * FROM warehouse_apps WHERE name='Chart gallery · Fictional company'")).rows[0];
 if(!app){const made=await manageIntegration(pool,actor,{action:'create',name:'Chart gallery · Fictional company',permissions:{metrics:{read:keys,write:keys,dimensions:{},snapshots:true,export:true},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}}});app=(await pool.query('SELECT * FROM warehouse_apps WHERE id=$1',[(made as {id:string}).id])).rows[0];}
 const seeded=(await pool.query("SELECT created_at FROM metrics WHERE key='gallery_revenue'")).rows[0];
 const anchor=new Date(seeded?.created_at??Date.now());
 const end=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),1));
 const start=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth()-1,1));
 const history=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth()-2,1));
 const days=Math.round((+end-+history)/86400000);
 const at=(day:number,hour=12,minute=0)=>new Date(+history+day*86400000+hour*3600000+minute*60000).toISOString();
 const metrics:Record<string,Metric>={};
 let accepted=0,duplicates=0;
 for(const spec of specs){
  const key='gallery_'+spec.key;
  const existing=(await pool.query('SELECT id FROM metrics WHERE key=$1',[key])).rows[0];
  const metric=existing?await getMetric(pool,key):await saveDefinition(pool,{...spec,key,name:spec.name+' · Gallery',description:'Fictional company chart gallery. Deterministic synthetic observations, never actual business records.',sourceId:app.source_id,inputMode:'measurements',timezone:'UTC',status:'active',freshnessSeconds:86400,storagePolicy:{baseResolution:'hour',baseRetentionDays:90,hourRetentionDays:90,dayRetentionDays:730,rawRetentionDays:null}},actor.id);
  metrics[spec.key]=metric;
  const records:Record<string,unknown>[]=[];
  const tuples=new Map<string,Record<string,string>>();
  const add=(d:number,value:number,dimensions:Record<string,string>={},sample=0)=>{const observedAt=at(d,12, sample);tuples.set(JSON.stringify(dimensions),dimensions);records.push({measurementId:`gallery:${spec.key}:${observedAt}:${JSON.stringify(dimensions)}`,metricKey:key,observedAt,value:value.toFixed(2),unit:spec.unit,dimensions,basis:'reported',evidence:'Synthetic chart gallery; fictional company.'});};
  for(let d=0;d<days;d++){
   const wave=1+Math.sin(d*.43)*.14,trend=1+d*.005;
   if(spec.key==='revenue')for(const [c,channel]of ['Direct','Partners','Online'].entries())for(const [r,region]of ['North','South','West'].entries())add(d,(310+c*95+r*45)*wave*trend*(1+Math.cos(d*.21+c)*.1),{channel,region});
   if(spec.key==='cash')for(const [n,account]of ['Operating','Reserve','Payroll'].entries())add(d,180000+n*75000+d*1400+Math.sin(d*.35+n)*16000,{account});
   if(spec.key==='latency')for(let n=0;n<20;n++)add(d,100+((d*17+n*31)%130)+Math.pow(n/19,4)*220,{},n);
   if(['spend','leads','orders'].includes(spec.key))for(const [r,region]of ['North','South','West'].entries())add(d,spec.key==='spend'?(400+r*220)*wave*trend:Math.round((spec.key==='leads'?70+r*50:15+r*12)*wave*trend*(1+Math.sin(d*.2+r)*.15)),{region});
   if(spec.key==='score')for(const [n,team]of ['Engineering','Finance','Marketing','Operations','Sales'].entries())add(d,60+n*5+Math.sin(d*.1+n)*9,{team});
   if(spec.key==='health')for(const [n,service]of ['API','Payments','Search'].entries())add(d,(d+n*7)%19===0?0:1,{service});
   if(spec.key==='funnel')for(const [n,stage]of ['01 · Visited','02 · Signed up','03 · Qualified','04 · Purchased'].entries())add(d,Math.round([5500,1700,650,220][n]*wave*trend),{stage});
   if(spec.key==='profit')for(const [n,component]of ['01 · Revenue','02 · Cost of goods','03 · Payroll','04 · Overhead','05 · Other income'].entries())add(d,[13000,-5200,-2700,-1600,750][n]*wave*trend,{component});
   if(spec.key==='goal')add(d,83+(d/days)*10+Math.sin(d*.2)*1.5);
  }
  for(let i=0;i<records.length;i+=500){const result=await ingest(pool,metric.sourceId,'measurements',{measurements:records.slice(i,i+500)});accepted+=result.accepted??0;duplicates+=result.duplicates??0;}
  while(await processMetricBatch(pool)){}
  for(const dimensions of tuples.values())await coverage(pool,metric.sourceId,{metricKey:key,dimensions,startsAt:history.toISOString(),endsAt:end.toISOString()});
 }
 // Only the gallery's own saved objects are upserted; reruns preserve IDs and avoid duplicates.
 async function save(name:string,kind:'query'|'view'|'dashboard',config:unknown){
  const old=(await pool.query('SELECT id,revision FROM metric_library WHERE name=$1 AND kind=$2 AND owner_id=$3',[name,kind,actor.id])).rows[0];
  return librarySave(pool,actor.id,{name,kind,visibility:'company',config,revision:old?.revision},old?.id);
 }
 const queries:Record<string,string>={};
 async function query(key:string,metricKey:string,groups:string[]=[],compare=false){
  const m=metrics[metricKey],q:MetricQuery={metricId:m.id,startsAt:start.toISOString(),endsAt:end.toISOString(),interval:'day',groupBy:groups,groupLimit:50,...(m.kind==='latest'?{aggregation:'mean' as const}:{})};
  queries[key]=(await save('Gallery input · '+key,'query',{query:{query:q,period:'fixed',compare}})).id;
 }
 await query('Revenue by channel','revenue',['channel']);
 await query('Total revenue','revenue');
 await query('Revenue by channel and region','revenue',['channel','region']);
 await query('Channel comparison','revenue',['channel'],true);
 await query('Account balances','cash',['account']);
 await query('Request duration','latency');
 for(const key of ['spend','leads','orders'])await query(key,key,['region']);
 await query('Team scores','score',['team']);
 await query('Service status','health',['service']);
 await query('Sales stages','funnel',['stage']);
 await query('Profit bridge','profit',['component']);
 await query('On-time delivery','goal');
 const views:string[]=[];
 for(const [i,kind]of chartKinds.entries()){
  let inputs=['Revenue by channel'],subject='Channel revenue';
  const chart:ChartOptions={kind};
  if(['number','calendar','table'].includes(kind)){inputs=['Total revenue'];subject='Daily sales';}
  if(kind==='step'){inputs=['Account balances'];subject='Account balances';}
  if(['sunburst','matrix','sankey'].includes(kind)){inputs=['Revenue by channel and region'];subject='Channels × regions';}
  if(['dumbbell','slope'].includes(kind)){inputs=['Channel comparison'];subject='Month-over-month sales';}
  if(kind==='waterfall'){inputs=['Profit bridge'];subject='Revenue to operating profit';chart.contributions=true;}
  if(kind==='funnel'){inputs=['Sales stages'];subject='Sales pipeline stages';chart.stageTotals=true;}
  if(['bullet','gauge'].includes(kind)){inputs=['On-time delivery'];subject='On-time delivery';chart.min=0;chart.max=100;chart.target=95;}
  if(['histogram','box'].includes(kind)){inputs=['Request duration'];subject='Individual request durations';}
  if(kind==='scatter'){inputs=['spend','leads'];subject='Campaign spend vs leads';}
  if(kind==='bubble'){inputs=['spend','leads','orders'];subject='Spend, leads & orders';}
  if(kind==='radar'){inputs=['Team scores'];subject='Team health';chart.min=0;chart.max=100;}
  if(kind==='state'){inputs=['Service status'];subject='Service availability';chart.stateThreshold=1;}
  const label=kind.replaceAll('_',' ');
  views.push((await save(`${String(i+1).padStart(2,'0')} · ${label[0].toUpperCase()+label.slice(1)} · ${subject}`,'view',{queryIds:inputs.map(k=>queries[k]),chart})).id);
 }
 views.splice(28,0,(await save('28b · Horizontal funnel · Sales pipeline stages','view',{queryIds:[queries['Sales stages']],chart:{kind:'funnel',stageTotals:true,orientation:'horizontal'}})).id);
 const dashboard=await save('Chart gallery · Fictional company','dashboard',{viewIds:views,layout:'grid'});
 const began=performance.now(),run=await libraryRun(pool,actor.id,dashboard.id);
 const failures=run.panels.flatMap(p=>p.data?(chartIssue(p.data,p.chart)?[`${p.name}: ${chartIssue(p.data,p.chart)}`]:[]):[`${p.name}: ${p.error}`]);
 assert.deepEqual(failures,[],'Every gallery chart must have eligible measured inputs.');
 assert.equal(run.panels.length,chartKinds.length+1);
 console.log(JSON.stringify({dashboardId:dashboard.id,url:`http://localhost:4332/metrics?workspace=studio&item=${dashboard.id}`,charts:run.panels.length,queries:Object.keys(queries).length,metrics:specs.length,accepted,duplicates,queryMs:Math.round(performance.now()-began),period:{startsAt:start.toISOString(),endsAt:end.toISOString()},validated:true},null,2));
}finally{await pool.end();}
