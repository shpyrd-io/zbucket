import {describe,it,expect} from 'vitest';
import {FunnelStream} from './funnel-stream';
import {evaluateFunnel} from './events';
import {funnelPeriods} from './funnel-periods';
const query={sourceId:'source',datasetKey:'app',schemaVersion:1,unit:'person' as const,startsAt:'2026-11-01T00:00:00Z',endsAt:'2026-11-08T00:00:00Z',steps:[{name:'a'},{name:'b'}],windowSeconds:86400};
describe('streamed exact funnel',()=>{
 it('matches the existing oracle across repeated steps, ties, retries and actor boundaries',()=>{
  for(let seed=1;seed<=300;seed++){
   let n=seed;const rand=()=>n=(Math.imul(n,1664525)+1013904223)>>>0;
   const steps=Array.from({length:2+seed%7},()=>({name:['a','b','c'][rand()%3]}));
   const events=Array.from({length:100},(_,i)=>({actor:String(rand()%12),eventId:String(i).padStart(4,'0'),occurredAt:new Date(Math.floor(i/2)*1000).toISOString(),name:['a','b','c'][rand()%3],data:{}}));
   const expected=evaluateFunnel(events,steps,seed%30+1);
   const stream=new FunnelStream(steps.length,(seed%30+1)*1000),members=[];
   for(const e of [...events].sort((a,b)=>a.actor.localeCompare(b.actor)||a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId))){const m=stream.push(e.actor,Date.parse(e.occurredAt),steps.reduce((mask,s,i)=>mask|(s.name===e.name?1<<i:0),0));if(m)members.push(m);}
   const last=stream.finish();if(last)members.push(last);
   expect(stream.counts).toEqual(expected.steps.map(s=>s.count));expect(members.sort((a,b)=>a.id<b.id?-1:1)).toEqual(expected.participants);expect(stream.finish()).toBeNull();
  }
 });
 it('resolves rolling, custom and previous periods without summing daily uniques',()=>{
  const r=funnelPeriods({query,period:'last_7_days',compare:'previous_period'},new Date('2026-11-15T12:03:42Z'));
  expect(r.current).toEqual({startsAt:'2026-11-08T12:00:00.000Z',endsAt:'2026-11-15T12:00:00.000Z'});expect(r.comparison?.endsAt).toBe(r.current.startsAt);
  const leap=funnelPeriods({query:{...query,startsAt:'2024-02-29T12:00:00Z',endsAt:'2024-03-01T12:00:00Z'},period:'fixed',compare:'previous_year'});expect(leap.comparison?.startsAt).toBe('2023-02-28T12:00:00.000Z');
  const custom=funnelPeriods({query,period:'fixed',compare:'custom',compareStartsAt:'2026-10-01T00:00:00Z',compareEndsAt:'2026-10-08T00:00:00Z'});expect(custom.comparison?.startsAt).toBe('2026-10-01T00:00:00Z');
 });
 it('uses calendar timezone for month boundaries across daylight saving',()=>{
  expect(funnelPeriods({query,period:'last_month',timezone:'America/New_York'},new Date('2026-12-02T12:00:00Z')).current).toEqual({startsAt:'2026-11-01T04:00:00.000Z',endsAt:'2026-12-01T05:00:00.000Z'});
 });
});
