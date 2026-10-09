import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createSource, saveDefinition, ingest } from '../../src/server/metrics/service';
import { processMetricBatch } from '../../src/server/metrics/worker';
import { maintainMetricRetention } from '../../src/server/metrics/rollups';
import { queryMetric } from '../../src/server/metrics/query';
import type { Metric } from '../../src/models/metrics/types';

// This oracle reduces authoritative facts in memory with integer decimal arithmetic.
// It does not use the worker's SQL, stored base states or hierarchy helpers.
const decimal=(v:string|null):bigint|null=>{
 if(v===null)return null;
 const negative=v.startsWith('-'),[whole,fraction='']=v.replace('-','').split('.');
 assert.ok(fraction.length<=2);return (negative?-1n:1n)*BigInt(whole+fraction.padEnd(2,'0'));
};
type State={total:bigint;n:bigint;d:bigint;min:bigint|null;max:bigint|null;last:bigint|null;lastAt:number;lastKey:string;count:number};
const canonical=(s:State)=>JSON.stringify(s,(_,v)=>typeof v==='bigint'?String(v):v);
export async function publicationAcceptance(pool:pg.Pool){
 const checks:string[]=[],owner=randomUUID(),source=await createSource(pool,'Incremental publication acceptance',owner);
 const policy={baseResolution:'minute',baseRetentionDays:3650,hourRetentionDays:3650,dayRetentionDays:3650,rawRetentionDays:null};
 const metrics:Metric[]=[];
 const define=async(key:string,kind:string,extra={})=>{
  const m=await saveDefinition(pool,{key:'publication_'+key,name:key,kind,sourceId:source.id,inputMode:'measurements',unit:'USD',dimensions:['entity'],maxSeries:1000,status:'active',timezone:'UTC',storagePolicy:policy,...extra},owner);metrics.push(m);return m;
 };
 for(const kind of ['sum','mean','ratio','min','max','count','latest'])await define(kind,kind);
 for(const baseResolution of ['5_minutes','15_minutes','hour','day'])await define(baseResolution,'sum',{storagePolicy:{...policy,baseResolution}});
 const start=Date.parse('2026-01-01T00:00:00Z');
 const record=(m:Metric,id:string,minute:number,value:string,entity='A')=>({measurementId:id,metricKey:m.key,definitionVersion:m.version,observedAt:new Date(start+minute*60000).toISOString(),value,numerator:value,denominator:'2',unit:'USD',dimensions:{entity}});
 const drain=async(batchSize=1000)=>{while(await processMetricBatch(pool,batchSize)){};};
 const oracle=async()=>{
  const defs=new Map(metrics.map(m=>[m.id+':'+m.version,m]));
  const facts=(await pool.query('SELECT * FROM metric_facts WHERE source_id=$1',[source.id])).rows;
  const expected=new Map<string,State>();
  for(const f of facts){
   const m=defs.get(f.metric_id+':'+f.version)!;if(!m?.storagePolicy)continue;
   const widths=[...new Set([({minute:1,'5_minutes':5,'15_minutes':15,hour:60,day:1440})[m.storagePolicy.baseResolution],...(m.storagePolicy.baseResolution==='day'?[]:[60,1440])])];
   const levelNames=new Map([[1,'minute'],[5,'5_minutes'],[15,'15_minutes'],[60,'hour'],[1440,'day']]);
   for(const width of widths){
    const observed=+new Date(f.observed_at),bucket=Math.floor(observed/(width*60000))*width*60000;
    const key=[m.id,m.version,levelNames.get(width),bucket,JSON.stringify(f.dimensions)].join('|');
    const s=expected.get(key)??{total:0n,n:0n,d:0n,min:null,max:null,last:null,lastAt:-Infinity,lastKey:'',count:0};
    const v=decimal(f.v),n=decimal(f.n)!,d=decimal(f.d)!;
    s.total+=v??0n;s.n+=n;s.d+=d;s.count++;
    if(v!==null){s.min=s.min===null||v<s.min?v:s.min;s.max=s.max===null||v>s.max?v:s.max;}
    const lastKey=f.source_id+':'+f.record_id;
    if(observed>s.lastAt||observed===s.lastAt&&lastKey>s.lastKey){s.last=v;s.lastAt=observed;s.lastKey=lastKey;}
    expected.set(key,s);
   }
  }
  const actual=(await pool.query('SELECT * FROM metric_rollups WHERE metric_id=ANY($1::uuid[]) ORDER BY metric_id,version,level,bucket,dimensions',[metrics.map(m=>m.id)])).rows;
  assert.equal(actual.length,expected.size,'No missing, extra or duplicate materialized states');
  for(const r of actual){
   const key=[r.metric_id,r.version,r.level,+new Date(r.bucket),JSON.stringify(r.dimensions)].join('|');
   const value:State={total:decimal(r.total)!,n:decimal(r.n)!,d:decimal(r.d)!,min:decimal(r.min),max:decimal(r.max),last:decimal(r.last),lastAt:+new Date(r.last_at),lastKey:r.last_key,count:Number(r.count)};
   assert.equal(canonical(value),canonical(expected.get(key)!),`Raw/state mismatch: ${key}`);
  }
  const legacy=(await pool.query('SELECT count(*) n FROM metric_aggregate_states a JOIN metric_definition_versions v USING(metric_id,version) WHERE a.metric_id=ANY($1::uuid[]) AND v.config->\'storagePolicy\'<>\'null\'::jsonb',[metrics.map(m=>m.id)])).rows[0];
  assert.equal(legacy.n,'0','Policy definitions must not write legacy hourly states');
 };
 const initial=metrics.flatMap((m,j)=>Array.from({length:36},(_,i)=>record(m,`initial_${j}_${i}`,((i*137)%3000)+i/100,`${i%3===0?'-':''}${i%11}.25`,'E'+i%4)));
 // Different batch boundaries and out-of-order arrivals must not change statistics.
 for(let offset=0;offset<initial.length;offset+=73){await ingest(pool,source.id,'measurements',{measurements:initial.slice(offset,offset+73).reverse()});await drain(31);}
 await oracle();checks.push('Incremental states match raw decimal oracle for seven reducers and five resolutions');
 for(let offset=0;offset<initial.length;offset+=1000){const r=await ingest(pool,source.id,'measurements',{measurements:initial.slice(offset,offset+1000)});assert.equal(r.accepted,0);}
 await drain();await oracle();checks.push('Repeated batches cannot add a second contribution at any level');
 const sumMetric=metrics[0],sumQuery={metricId:sumMetric.id,startsAt:new Date(start).toISOString(),endsAt:new Date(start+3*86400000).toISOString(),interval:'day' as const};
 const before=(await queryMetric(pool,sumQuery)).value;
 await ingest(pool,source.id,'measurements',{measurements:[record(sumMetric,'rollback',10,'99.25')]});
 await assert.rejects(processMetricBatch(pool,1000,true),/Injected/);
 assert.equal((await queryMetric(pool,sumQuery)).value,before);await oracle();
 await Promise.all([processMetricBatch(pool),processMetricBatch(pool)]);await drain();await oracle();
 checks.push('Rollback and competing workers preserve atomic exactly-once publication');
 const latest=metrics.find(m=>m.kind==='latest')!;
 for(const [id,minute,value]of [['tie_z',50,'25.00'],['tie_a',50,'99.00'],['older',40,'200.00']] as const){await ingest(pool,source.id,'measurements',{measurements:[record(latest,id,minute,value,'tie')]});await drain();}
 await oracle();assert.equal((await pool.query("SELECT last FROM metric_rollups WHERE metric_id=$1 AND level='day' AND dimensions=$2",[latest.id,{entity:'tie'}])).rows[0].last,'25.00');
 checks.push('Late and equal-time snapshots keep a deterministic latest value across batches');
 const replacements=metrics.map((m,j)=>({...initial.find(r=>r.metricKey===m.key)!,revision:2,value:'55.75',numerator:'55.75',observedAt:new Date(start+4*86400000).toISOString(),dimensions:{entity:'Moved'+j}}));
 await ingest(pool,source.id,'measurements',{measurements:replacements},undefined,true);
 await ingest(pool,source.id,'measurements',{measurements:[record(sumMetric,'mixed_append',100,'7.25')]});
 await assert.rejects(processMetricBatch(pool,1000,true),/Injected/);await oracle();
 checks.push('Failed correction publication rolls back facts and every aggregation level together');
 await drain();await oracle();checks.push('Mixed correction/append batches rebuild old and new periods and dimension tuples');
 for(const m of metrics.slice(0,7)){const r=replacements.find(r=>r.metricKey===m.key)!;await ingest(pool,source.id,'measurements',{recordId:r.measurementId,revision:3,tombstone:true,reason:'Synthetic retraction'},undefined,true);}
 await drain();await oracle();checks.push('Retractions remove empty buckets and restore extrema and latest values');
 const pending=record(sumMetric,'superseded',20,'3.00');
 await ingest(pool,source.id,'measurements',{measurements:[pending]});
 await ingest(pool,source.id,'measurements',{measurements:[{...pending,revision:2,value:'8.00'}]},undefined,true);
 await ingest(pool,source.id,'measurements',{measurements:[{...pending,revision:3,value:'9.00'}]},undefined,true);
 await drain(1);await oracle();checks.push('Superseded revisions spanning worker batches do not leave stale contributions');
 // Force the exact same facts through the reconstruction path, then compare all sufficient states again.
 const tie=record(latest,'tie_z',50,'25.00','tie');
 await ingest(pool,source.id,'measurements',{measurements:[{...tie,revision:2}]},undefined,true);await drain();await oracle();
 checks.push('Incremental and reconstructed sufficient statistics agree');
 await assert.rejects(saveDefinition(pool,{...sumMetric,storagePolicy:undefined},owner,sumMetric.id,1),/immutable/);
 const replacementMetric=await saveDefinition(pool,{...sumMetric,key:sumMetric.key+'_raw',name:'Separate raw contract',storagePolicy:undefined},owner);metrics.push(replacementMetric);
 await ingest(pool,source.id,'measurements',{measurements:[{...pending,metricKey:replacementMetric.key,definitionVersion:1,revision:4,value:'12.00'}]},undefined,true);await drain();await oracle();
 assert.equal(Number((await queryMetric(pool,{...sumQuery,metricId:replacementMetric.id})).value),12);
 checks.push('A changed storage contract requires a new metric; explicit corrections preserve source history');
 const eventSource=await createSource(pool,'Mixed dataset',owner);
 await pool.query('INSERT INTO metric_datasets(source_id,key,version,schema) VALUES($1,$2,1,$3)',[eventSource.id,'fanout',{value:'decimal'}]);
 const makeEventMetric=(key:string,storagePolicy:typeof policy|undefined)=>saveDefinition(pool,{key,name:key,sourceId:eventSource.id,kind:'sum',unit:'USD',inputMode:'events',datasetKey:'fanout',dimensions:[],status:'active',timezone:'UTC',storagePolicy},owner);
 const policyEvent=await makeEventMetric('publication_policy_event',policy),legacyEvent=await makeEventMetric('publication_legacy_event',undefined);
 await ingest(pool,eventSource.id,'events',{datasetKey:'fanout',schemaVersion:1,events:[{eventId:'fanout',occurredAt:new Date(start).toISOString(),data:{value:'0.25'}}]});await drain();
 assert.deepEqual((await pool.query('SELECT metric_id FROM metric_aggregate_states WHERE metric_id=ANY($1::uuid[])',[[policyEvent.id,legacyEvent.id]])).rows,[{metric_id:legacyEvent.id}]);
 for(const m of [policyEvent,legacyEvent])assert.equal(Number((await queryMetric(pool,{...sumQuery,metricId:m.id})).value),.25);
 checks.push('One dataset can publish policy and legacy metrics without duplicate materialization');
 const interval=await define('weighted_intervals','mean',{inputMode:'aggregates'});
 const aggregate=(id:string,minute:number,total:string,count:number)=>({aggregateId:id,metricKey:interval.key,definitionVersion:1,startsAt:new Date(start+minute*60000).toISOString(),endsAt:new Date(start+(minute+1)*60000).toISOString(),dimensions:{entity:'A'},unit:'USD',state:{kind:'mean',sum:total,count}});
 for(const r of [aggregate('weighted_a',0,'100',2),aggregate('weighted_b',1,'900',18)]){await ingest(pool,source.id,'aggregates',{aggregates:[r]});await drain();}
 assert.equal(Number((await queryMetric(pool,{...sumQuery,metricId:interval.id})).value),50);await oracle();
 await assert.rejects(ingest(pool,source.id,'aggregates',{aggregates:[aggregate('valid',2,'1',1),{...aggregate('invalid',3,'1',1),endsAt:new Date(start+4.5*60000).toISOString()}]}),/base bucket/);
 assert.equal((await pool.query("SELECT count(*) n FROM metric_record_keys WHERE source_id=$1 AND record_id IN ('valid','invalid')",[source.id])).rows[0].n,'0');
 checks.push('Batched interval validation remains atomic and weighted averages remain exact');
 const mixed=await define('mixed_interval','sum');
 const intervalRecord={...record(mixed,'interval_first',0,'10.00'),startsAt:new Date(start).toISOString(),endsAt:new Date(start+60000).toISOString()};
 await ingest(pool,source.id,'measurements',{measurements:[intervalRecord]});
 await assert.rejects(ingest(pool,source.id,'measurements',{measurements:[record(mixed,'overlapping_point',.5,'1.00')]}),/Overlapping/);
 await drain();await oracle();checks.push('Indexed interval lookup rejects point overlap before an interval is processed');
 // Expiring fine resolution must not corrupt a retained daily total on late append/correction.
 const retained=await define('retained','sum',{storagePolicy:{...policy,baseRetentionDays:1,hourRetentionDays:1,dayRetentionDays:3650}});
 const oldA=record(retained,'retained_a',0,'10.00'),oldB=record(retained,'retained_b',60,'20.00');
 await ingest(pool,source.id,'measurements',{measurements:[oldA,oldB]});await drain();
 await maintainMetricRetention(pool,new Date(start+10*86400000));
 assert.equal((await pool.query("SELECT count(*) n FROM metric_rollups WHERE metric_id=$1 AND level<>'day'",[retained.id])).rows[0].n,'0');
 await ingest(pool,source.id,'measurements',{measurements:[record(retained,'retained_c',120,'5.00')]});await drain();
 const retainedQuery={...sumQuery,metricId:retained.id};assert.equal(Number((await queryMetric(pool,retainedQuery)).value),35);
 await ingest(pool,source.id,'measurements',{measurements:[{...oldA,revision:2,value:'11.00'}]},undefined,true);await drain();
 assert.equal(Number((await queryMetric(pool,retainedQuery)).value),36);
 checks.push('Retained daily totals survive late append and correction after fine states expire');
 return checks;
}
