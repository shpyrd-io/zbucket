import type { MetricResult } from './types';
import { localInstant } from './calendar';

// Align calendar days rather than elapsed milliseconds, so DST does not move a
// baseline observation away from the corresponding reporting day.
function calendarDay(iso:string,zone:string) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
 return Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day));
}
export function metricChartSeries(result:Pick<MetricResult,'metric'|'startsAt'|'endsAt'|'series'|'comparison'|'interval'>) {
 const zone=result.metric.timezone;
 const currentDay=calendarDay(result.startsAt,zone);
 const range=(start:string,end:string)=>`${start.slice(0,10)} – ${end.slice(0,10)} (end exclusive)`;
 const points=(series:MetricResult['series'],start:string,end:string,aligned=false):[number,number][]=>{
  const first=calendarDay(start,zone),last=Date.parse(end);
  return series.flatMap((p,index)=>{
   if(p.value===null || !Number.isFinite(Number(p.value)) || calendarDay(p.startsAt,zone)<first || Date.parse(p.startsAt)>=last)return[];
   let timestamp=Date.parse(p.startsAt);
   if(aligned){
    const date=new Date(currentDay+calendarDay(p.startsAt,zone)-first);
    timestamp=result.interval&&['minute','5_minutes','15_minutes','hour'].includes(result.interval)?Date.parse(result.startsAt)+Date.parse(p.startsAt)-Date.parse(start):result.interval&&['week','month'].includes(result.interval)&&result.series[index]?Date.parse(result.series[index].startsAt):Date.parse(localInstant(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),zone));
    if(timestamp>=Date.parse(result.endsAt))return[];
   }
   // Shared TimeChart accepts Unix seconds.
   return [[timestamp/1000,Number(p.value)]];
  });
 };
 const series=[{name:`Current · ${range(result.startsAt,result.endsAt)}`,points:points(result.series,result.startsAt,result.endsAt)}];
 if(result.comparison){
  const previous=result.comparison;
  series.push({name:`Previous · ${range(previous.startsAt,previous.endsAt)} · ${previous.quality}`,points:points(previous.series??[],previous.startsAt,previous.endsAt,true)});
 }
 return series;
}
