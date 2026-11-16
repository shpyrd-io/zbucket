import {check,instant,object,text} from './validation';

export type EventMapping={name:string;userId?:string;accountId?:string;sessionId?:string;properties?:string};
export type EventDataset={sourceId:string;datasetKey:string;schemaVersion:number;mapping:EventMapping;retentionDays:number;sourceName?:string;backfilled?:boolean;skippedRecords?:number};
export type BehaviorEvent={eventId:string;revision:number;occurredAt:string;receivedAt:string;name:string;userId:string|null;accountId:string|null;sessionId:string|null;data:Record<string,unknown>};
export type FunnelStep={name:string;properties?:Record<string,string|number|boolean|null>};
export type FunnelEvent={eventId:string;occurredAt:string;name:string;actor:string;data:Record<string,unknown>};
export function eventMapping(input:unknown,schema:Record<string,unknown>):EventMapping{
 const m=object(input),out:Record<string,string>={};
 for(const key of ['name','userId','accountId','sessionId']){
  if(key!=='name'&&(m[key]===undefined||m[key]===''))continue;
  const field=text(m[key],key,64);check(schema[field]==='string'||(key!=='name'&&schema[field]==='string?'),`${key} must map to a declared string field.`);out[key]=field;
 }
 if(m.properties!==undefined){const field=text(m.properties,'Properties',64);check(schema[field]==='properties','Properties must map to a properties field.');out.properties=field;}
 check(out.userId||out.accountId,'Map a person or account field.');
 return out as EventMapping;
}
export function eventFields(record:unknown,mapping:EventMapping){
 const r=object(record),data=object(r.data);
 const optional=(field:string|undefined)=>field&&data[field]!==null?text(data[field],field,200):null;
 return {occurredAt:instant(r.occurredAt),name:text(data[mapping.name],'Event name',200),userId:optional(mapping.userId),accountId:optional(mapping.accountId),sessionId:optional(mapping.sessionId)};
}
export function funnelSteps(input:unknown):FunnelStep[]{
 check(Array.isArray(input)&&input.length>=2&&input.length<=8,'Choose 2–8 funnel steps.');
 return input.map(raw=>{const r=object(raw),properties=object(r.properties??{});check(Object.keys(properties).length<=8&&Object.entries(properties).every(([k,v])=>k.length<=64&&(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=1000)),'Use up to eight exact scalar property filters per step.');return{name:text(r.name,'Event name'),properties:properties as Record<string,string|number|boolean|null>};});
}
// Input is chronologically ordered. A later start dominates an earlier prefix of
// the same length. Descending updates prevent one occurrence matching two steps.
export function evaluateFunnel(events:FunnelEvent[],steps:FunnelStep[],windowSeconds:number){
 const actors=new Map<string,{starts:(number|undefined)[];reached:number}>();
 for(const e of events){
  let state=actors.get(e.actor);if(!state){state={starts:[],reached:0};actors.set(e.actor,state);}
  const at=Date.parse(e.occurredAt);
  for(let i=steps.length-1;i>=0;i--){
   const step=steps[i];if(e.name!==step.name||!Object.entries(step.properties??{}).every(([k,v])=>e.data[k]===v))continue;
   const start=i===0?at:state.starts[i-1];
   if(start===undefined||at-start>windowSeconds*1000)continue;
   state.starts[i]=Math.max(state.starts[i]??-Infinity,start);state.reached=Math.max(state.reached,i+1);
  }
 }
 const participants=[...actors].filter(([,s])=>s.reached>0).map(([id,s])=>({id,reached:s.reached})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const counts=steps.map((step,i)=>({name:step.name,count:participants.filter(p=>p.reached>i).length}));
 return {steps:counts,participants};
}
