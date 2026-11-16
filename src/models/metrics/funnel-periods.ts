import {metricPeriod,localInstant} from './calendar';
import type {SavedEventFunnel} from './library';
export function funnelPeriods(saved:SavedEventFunnel,now=new Date()){
 const zone=saved.timezone??'UTC';
 // Stable refresh boundaries make rolling queries reusable across dashboard readers.
 const anchor=new Date(Math.floor(now.getTime()/300000)*300000);
 const current=saved.period==='fixed'?{startsAt:saved.query.startsAt,endsAt:saved.query.endsAt}:metricPeriod(saved.period,zone,anchor);
 let comparison:typeof current|undefined;
 if(saved.compare==='previous_period'){
  const size=Date.parse(current.endsAt)-Date.parse(current.startsAt);
  comparison={startsAt:new Date(Date.parse(current.startsAt)-size).toISOString(),endsAt:current.startsAt};
 }else if(saved.compare==='previous_year'){
  const shift=(value:string)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));const days=new Date(Date.UTC(p.year-1,p.month,0)).getUTCDate();return localInstant(p.year-1,p.month,Math.min(p.day,days),zone,p.hour,p.minute,p.second);};
  comparison={startsAt:shift(current.startsAt),endsAt:shift(current.endsAt)};
 }else if(saved.compare==='custom')comparison={startsAt:saved.compareStartsAt!,endsAt:saved.compareEndsAt!};
 return {current,comparison,timezone:zone};
}
