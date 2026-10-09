import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import {metricQueryOptions,manualMetricRefresh} from './metric-query-refresh';
import { metricsApi } from '@/api/metrics';
import type { MetricQuery } from '@/models/metrics/types';
export function useMetrics(search='',after=''){return useQuery({queryKey:['metrics',search,after],queryFn:()=>metricsApi.catalog(search,after),...manualMetricRefresh});}
export function useMetricQuery(q:MetricQuery,livePeriod?:string){return useQuery({...metricQueryOptions('metric-query',q,metricsApi.query,livePeriod),enabled:!!q.metricId});}
export function useMetricDetail(id:string,version?:number){return useQuery({...manualMetricRefresh,queryKey:['metric-detail',id,version],queryFn:()=>metricsApi.detail(id,version),enabled:!!id});}
export function useMetricCommand(){const qc=useQueryClient();return useMutation({mutationFn:metricsApi.command,onSuccess:()=>{for(const key of ['metrics','metric-query','metric-detail','metric-data','metric-sources','metric-goal','metric-library-run','metric-distribution','investigation'])void qc.invalidateQueries({queryKey:[key]});}});}

export function useMetricData(id:string,after='',version?:number){return useQuery({queryKey:['metric-data',id,after,version],queryFn:()=>metricsApi.data(id,after,version),enabled:!!id,...manualMetricRefresh});}
export function useMetricSources(){return useQuery({queryKey:['metric-sources'],queryFn:metricsApi.sources,...manualMetricRefresh});}
export function useMetricGoal(id:string){return useQuery({queryKey:['metric-goal',id],queryFn:()=>metricsApi.goal(id),...manualMetricRefresh});}

export function useMetricExport(id:string){return useQuery({queryKey:['metric-export',id],queryFn:()=>metricsApi.exportStatus(id),enabled:!!id,refetchInterval:q=>['completed','failed'].includes(q.state.data?.status??'')?false:2000});}

export function useRefreshMetrics(){
 const qc=useQueryClient();
 return (refreshResults=true)=>{
  const keys=new Set(['metrics','metric-detail','metric-data','metric-sources','metric-goal',...(refreshResults?['metric-query','metric-distribution']:[])]);
  return qc.invalidateQueries({predicate:query=>keys.has(String(query.queryKey[0])),refetchType:'active'});
 };
}
