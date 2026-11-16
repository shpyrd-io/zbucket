import {describe,it,expect} from 'vitest';
import {evaluateFunnel,eventMapping,eventFields,funnelSteps,type FunnelEvent} from './events';
const e=(name:string,second:number,actor='a',id=String(second),data:Record<string,unknown>={}):FunnelEvent=>({name,occurredAt:new Date(second*1000).toISOString(),actor,eventId:id,data});
const steps=funnelSteps([{name:'open'},{name:'signup'},{name:'use'}]);
describe('ordered behavior funnels',()=>{
 it('counts unique actors, not event counts; ignores unrelated events and wrong order',()=>{
  const r=evaluateFunnel([e('use',0),e('open',1),e('signup',2),e('other',3),e('use',4),e('use',5),e('open',6,'b')],steps,20);
  expect(r.steps.map(s=>s.count)).toEqual([2,1,1]);expect(r.participants).toEqual([{id:'a',reached:3},{id:'b',reached:1}]);
 });
 it('allows a later attempt to convert when the first attempt expires',()=>{
  const r=evaluateFunnel([e('open',0),e('signup',1),e('open',10),e('signup',11),e('use',15)],steps,5);expect(r.steps.map(s=>s.count)).toEqual([1,1,1]);
 });
 it('measures the window from the first step, including its exact boundary',()=>{
  expect(evaluateFunnel([e('open',0),e('signup',4),e('use',6)],steps,5).steps.map(s=>s.count)).toEqual([1,1,0]);
  expect(evaluateFunnel([e('open',0),e('signup',4),e('use',5)],steps,5).steps.map(s=>s.count)).toEqual([1,1,1]);
 });
 it('requires separate occurrences for repeated steps, including equal timestamps',()=>{
  const twice=[{name:'open'},{name:'open'}];expect(evaluateFunnel([e('open',0)],twice,5).steps.map(s=>s.count)).toEqual([1,0]);
  expect(evaluateFunnel([e('open',0,'a','1'),e('open',0,'a','2')],twice,5).steps.map(s=>s.count)).toEqual([1,1]);
 });
 it('applies each step property filter without coercion',()=>{
  const filters=[{name:'open'},{name:'use',properties:{feature:'export'}}];
  expect(evaluateFunnel([e('open',0),e('use',1,'a','1',{feature:'import'})],filters,5).steps[1].count).toBe(0);
 });
 it('matches a brute-force sequence oracle across repeated events and windows',()=>{
  for(let seed=0;seed<150;seed++){
   let n=seed+1;const rand=()=>{n=(n*1664525+1013904223)>>>0;return n;};
   const target=[{name:'a'},{name:seed%2?'a':'b'},{name:'c'}],events=Array.from({length:12},(_,i)=>e(['a','b','c'][rand()%3],i));
   const window=1+seed%8;let best=0;
   const visit=(position:number,stage:number,start:number)=>{best=Math.max(best,stage);if(stage===target.length)return;for(let i=position;i<events.length;i++)if(events[i].name===target[stage].name&&(stage===0||i-start<=window))visit(i+1,stage+1,stage===0?i:start);};visit(0,0,0);
   expect(evaluateFunnel(events,target,window).steps.map(s=>s.count)).toEqual(target.map((_,i)=>i<best?1:0));
  }
 });
});
it('validates mapped string fields, identity and occurrence timestamps',()=>{
 expect(()=>eventMapping({name:'amount',accountId:'account'},{amount:'decimal',account:'string'})).toThrow();
 expect(()=>eventMapping({name:'action'},{action:'string'})).toThrow();
 const mapping=eventMapping({name:'action',accountId:'account'},{action:'string',account:'string'});
 expect(()=>eventFields({occurredAt:'not-a-date',data:{action:'open',account:'a'}},mapping)).toThrow();
 expect(()=>eventFields({occurredAt:'2026-11-14T00:00:00Z',data:{action:'open'}},mapping)).toThrow();
});
