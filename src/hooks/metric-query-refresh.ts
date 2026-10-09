import {hashKey} from '@tanstack/react-query';
import type {MetricQuery} from '@/models/metrics/types';

export const manualMetricRefresh={
 refetchInterval:false as const,
 refetchOnWindowFocus:false,
 refetchOnReconnect:false,
};
function scope(query:MetricQuery){
 const {startsAt:_,endsAt:__,compareStartsAt,compareEndsAt,...rest}=query;
 return {...rest,comparison:!!(compareStartsAt&&compareEndsAt)};
}
// Preserve a completed result while a manual refresh advances the same live report.
// Changing the metric, definition, period, filters, comparison or grouping starts fresh.
export function metricQueryOptions<T>(namespace:string,query:MetricQuery,fetchQuery:(q:MetricQuery)=>Promise<T>,livePeriod?:string){
 const queryKey=[namespace,query,livePeriod??null] as const;
 return {
  queryKey,
  queryFn:()=>fetchQuery(query),
  placeholderData:(previous:T|undefined,previousQuery?:{queryKey:readonly unknown[]})=>{
   if(!previous||!livePeriod||previousQuery?.queryKey[0]!==namespace||previousQuery.queryKey[2]!==livePeriod)return undefined;
   const old=previousQuery.queryKey[1] as MetricQuery;
   return hashKey([scope(old)])===hashKey([scope(query)])?previous:undefined;
  },
  ...manualMetricRefresh,
  retry:false as const,
 };
}
