import {describe,it,expect} from 'vitest';
import {FunnelOccurrences} from './funnel-occurrences';
import {FunnelStream} from './funnel-stream';
describe('Period-independent funnel occurrences',()=>{
 it('matches direct evaluation across arbitrary boundaries, repeated steps, ties, attempts and windows',()=>{
  let seed=97;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
  for(let sample=0;sample<400;sample++){
   const stages=2+Math.floor(random()*7),window=1+Math.floor(random()*30);
   const events=Array.from({length:80},(_,id)=>({id,actor:'p'+Math.floor(random()*4),at:Math.floor(random()*60),mask:Math.floor(random()*(1<<stages))})).sort((a,b)=>a.actor.localeCompare(b.actor)||a.at-b.at||a.id-b.id);
   const state=new FunnelOccurrences(stages,window),occurrences=events.flatMap(e=>state.push(e.actor,e.at,e.mask));
   for(let period=0;period<20;period++){
    const from=Math.floor(random()*50),until=from+1+Math.floor(random()*30),direct=new FunnelStream(stages,window);
    for(const e of events)if(e.at>=from&&e.at<until)direct.push(e.actor,e.at,e.mask);direct.finish();
    const counts=Array.from({length:stages},(_,i)=>new Set(occurrences.filter(o=>o.stage===i+1&&Date.parse(o.startedAt)>=from&&Date.parse(o.reachedAt)<until).map(o=>o.actor)).size);
    expect(counts,{sample,from,until} as never).toEqual(direct.counts);
   }
  }
 });
 it('keeps cross-day conversion and new attempts while avoiding identical-start duplicates',()=>{
  const state=new FunnelOccurrences(2,100);
  const occurrences=[...state.push('ana',10,1),...state.push('ana',20,2),...state.push('ana',21,2),...state.push('ana',30,1),...state.push('ana',40,2)];
  expect(occurrences.filter(o=>o.stage===2).map(o=>[Date.parse(o.startedAt),Date.parse(o.reachedAt)])).toEqual([[10,20],[30,40]]);
 });
});
