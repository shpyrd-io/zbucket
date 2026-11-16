import type {PlotData} from './visualization';
import type {SavedEventFunnel} from './library';
type Result={steps:{name:string;count:number}[];recomputing:boolean;skippedRecords?:number;asOf?:string|null;stale?:boolean};
export function eventFunnelPlot(result:Result,query:SavedEventFunnel['query'],comparison?:Result,comparisonBounds?:{startsAt:string;endsAt:string},timezone='UTC'):PlotData{
 const unit=query.unit==='person'?'people':'accounts';
 return {title:'Event conversion',unit,timezone,interval:'funnel',startsAt:query.startsAt,endsAt:query.endsAt,measurementKind:'event_funnel',additive:false,partition:false,completeGroups:true,
 series:result.steps.map((s,i)=>({id:String(i),name:s.name,unit,dimensions:{stage:s.name},total:String(s.count),points:[{key:query.startsAt,value:String(s.count),quality:result.recomputing?'provisional':'observed'}]})),
 rows:result.steps.map((s,i)=>({key:String(i),label:`${i+1} · ${s.name}`,dimensions:{stage:s.name},value:String(s.count),...(comparison?{previous:String(comparison.steps[i].count)}:{})})),
 notes:[...(result.asOf?[`Data snapshot: ${result.asOf}${result.stale?' · newer events available; cached for up to five minutes':''}.`]:[]),...(comparisonBounds?[`Comparison: ${comparisonBounds.startsAt} to ${comparisonBounds.endsAt} (end exclusive). Independently counted unique participants.${comparison?.asOf?' Snapshot: '+comparison.asOf:''}`]:[]),`Ordered conversion by ${query.unit}; ${query.windowSeconds / 3600} hour window. Counts are unique within this report and must not be summed across days.`,...(result.recomputing?['Processing retained events. Results are provisional.']:[]),...(result.skippedRecords?[`${result.skippedRecords} historical records could not be indexed.`]:[])]};
}
