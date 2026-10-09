"use client";
import { useState } from "react";
import { Button } from "@shpyrd/ui/components/button";
import { SelectControl } from "./select-control";
import { useMetricCommand } from "@/hooks/metrics";
import type { Metric, MissingDataPolicy } from "@/models/metrics/types";

export function MetricMissingDataPolicy({ metric }: { metric: Metric }) {
 const [value,setValue]=useState<MissingDataPolicy>(metric.missingData??"leave_gaps");
 const command=useMetricCommand();
 return <form className="my-5 grid max-w-xl gap-3 rounded-md border p-4" onSubmit={e=>{
  e.preventDefault();if(command.isPending)return;
  command.mutate({path:`reporting-policy/${metric.id}`,data:{version:metric.version,expectedRevision:metric.reportingRevision??0,missingData:value}});
 }}>
  <label className="text-sm font-medium">Missing data
   <SelectControl value={value} onValueChange={v=>setValue(v as MissingDataPolicy)}>
    <option value="leave_gaps">Leave gaps</option><option value="keep_previous">Keep previous value</option>
   </SelectControl>
  </label>
  <p className="text-sm text-muted-foreground">Keep the last known reading until another arrives, or leave a gap when it is no longer fresh. Changes apply to this metric, including its existing measurements.</p>
  <p className="text-xs text-muted-foreground">Expected freshness: {metric.freshnessSeconds} seconds. Older readings are marked stale. Saved evidence keeps its original result.</p>
  {command.error&&<p role="alert" className="text-sm text-destructive">{command.error.message}</p>}
  <Button className="justify-self-start" type="submit" size="sm" disabled={command.isPending||value===(metric.missingData??"leave_gaps")}>{command.isPending?"Saving…":"Save policy"}</Button>
 </form>;
}
