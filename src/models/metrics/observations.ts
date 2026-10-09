import type { ObservationMetadata } from './types';
export function observationMetadata(value:ObservationMetadata):ObservationMetadata {
 return {observedAt:value.observedAt,oldestObservedAt:value.oldestObservedAt,knownCount:value.knownCount,expectedCount:value.expectedCount,staleCount:value.staleCount};
}
export function observationLabel(value:ObservationMetadata,timezone:string){
 const format=(at:string)=>new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(at));
 const parts:string[]=[];
 if(value.observedAt){
  const range=value.oldestObservedAt&&value.oldestObservedAt!==value.observedAt;
  parts.push(range?`Readings: ${format(value.oldestObservedAt!)} – ${format(value.observedAt)}`:`Last observed: ${format(value.observedAt)}`);
 }
 if(value.expectedCount!==undefined)parts.push(`${value.knownCount??0}/${value.expectedCount} series known`);
 if(value.staleCount)parts.push(`${value.staleCount} stale`);
 return parts.join(' · ');
}
