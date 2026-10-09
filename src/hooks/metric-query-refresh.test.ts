import {expect,it,vi} from 'vitest';
import {QueryClient,QueryObserver,focusManager,onlineManager} from '@tanstack/react-query';
import {metricQueryOptions} from './metric-query-refresh';
import type {MetricQuery} from '@/models/metrics/types';
const query:MetricQuery={metricId:'cash',version:1,startsAt:'2026-10-08T03:00:00Z',endsAt:'2026-10-08T13:00:00Z',interval:'hour',aggregation:'sum',dimensions:{account_id:'001'}};
const next={...query,endsAt:'2026-10-08T13:00:15Z'};
it('keeps the rendered result through a live refresh and replaces it on completion',async()=>{
 const client=new QueryClient();
 const original={value:'100'};let finish!:(data:{value:string})=>void;
 const fetcher=()=>new Promise<{value:string}>(resolve=>{finish=resolve;});
 const options=metricQueryOptions('metric-query',query,fetcher,'today');
 client.setQueryData(options.queryKey,original);
 const observer=new QueryObserver<{value:string}>(client,{...options,staleTime:Infinity});
 const stop=observer.subscribe(()=>{});
 try{
  observer.setOptions({...metricQueryOptions('metric-query',next,fetcher,'today'),staleTime:Infinity});
  expect(observer.getCurrentResult().data).toEqual(original);
  expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
  expect(observer.getCurrentResult().isPending).toBe(false);
  finish({value:'200'});
  await observer.refetch();
  expect(observer.getCurrentResult().data).toEqual({value:'200'});
  expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
 }finally{stop();client.clear();}
});
it('never shows another metric, version, filter, period, grouping or comparison as a placeholder',()=>{
 const previous={value:'100'},old={queryKey:['metric-query',query,'today']};
 const changes:Partial<MetricQuery>[]=[{metricId:'revenue'},{version:2},{dimensions:{}},{aggregation:'mean'},{interval:'day'},{groupBy:['account_id']},{groupAfter:'next'},{compareStartsAt:'2026-09-08T03:00:00Z',compareEndsAt:'2026-09-08T13:00:15Z'}];
 for(const change of changes)expect(metricQueryOptions('metric-query',{...next,...change},async()=>previous,'today').placeholderData(previous,old)).toBeUndefined();
 expect(metricQueryOptions('metric-query',next,async()=>previous,'mtd').placeholderData(previous,old)).toBeUndefined();
 expect(metricQueryOptions('metric-query',next,async()=>previous).placeholderData(previous,old)).toBeUndefined();
});
it('retains a rolling window with its comparison while both advance, without a second polling clock',()=>{
 const previous={value:'100'};
 const old={...query,compareStartsAt:'2026-09-08T03:00:00Z',compareEndsAt:'2026-09-08T13:00:00Z'};
 const fresh={...old,startsAt:'2026-10-08T03:00:15Z',endsAt:next.endsAt,compareStartsAt:'2026-09-08T03:00:15Z',compareEndsAt:'2026-09-08T13:00:15Z'};
 const options=metricQueryOptions('metric-query',fresh,async()=>previous,'last_30_days');
 expect(options.placeholderData(previous,{queryKey:['metric-query',old,'last_30_days']})).toBe(previous);
 expect(options.refetchInterval).toBe(false);
 expect(metricQueryOptions('metric-query',query,async()=>previous).refetchInterval).toBe(false);
});

it('does not refetch on time, focus or reconnect, but explicit refresh fetches new data',async()=>{
 vi.useFakeTimers();const client=new QueryClient();client.mount();
 let calls=0;const fetcher=async()=>({value:String(++calls)});
 const observer=new QueryObserver<{value:string}>(client,metricQueryOptions('metric-query',query,fetcher));
 const stop=observer.subscribe(()=>{});
 try{
  await observer.refetch();expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(60000);
  focusManager.setFocused(false);focusManager.setFocused(true);
  onlineManager.setOnline(false);onlineManager.setOnline(true);
  await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(1);
  await observer.refetch();expect(calls).toBe(2);expect(observer.getCurrentResult().data).toEqual({value:'2'});
 }finally{stop();client.unmount();client.clear();focusManager.setFocused(undefined);vi.useRealTimers();}
});
