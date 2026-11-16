import {metricQueryOptions,manualMetricRefresh} from './metric-query-refresh';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { metricLibraryApi } from "@/api/metric-library";
import type { MetricQuery } from "@/models/metrics/types";
export function useMetricLibrary() {
  return useQuery({
    ...manualMetricRefresh,
    queryKey: ["metric-library"],
    queryFn: metricLibraryApi.list,
  });
}
export function useSaveMetricLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: metricLibraryApi.save,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["metric-library"] });
      void qc.invalidateQueries({ queryKey: ["metric-library-run"] });
    },
  });
}
export function useDeleteMetricLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: metricLibraryApi.remove,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["metric-library"] });
    },
  });
}
export function useRunMetricLibrary(id: string) {
  return useQuery({
    ...manualMetricRefresh,
    queryKey: ["metric-library-run", id],
    queryFn: () => metricLibraryApi.run(id),
    enabled: !!id,
    retry: false,
    staleTime: 60000,
    refetchInterval:query=>query.state.data?.panels.some(p=>p.processing)?2000:false,
  });
}
export function useMetricDistribution(q: MetricQuery, enabled: boolean, livePeriod?: string) {
  return useQuery({
    ...metricQueryOptions("metric-distribution",q,metricLibraryApi.distribution,livePeriod),
    enabled: enabled && !!q.metricId && !!q.startsAt && !!q.endsAt,
    retry: false,
  });
}
