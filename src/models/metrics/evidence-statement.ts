import { observationLabel } from './observations';
import type { MetricResult } from './types';

export function metricEvidenceStatement(result:MetricResult,snapshotId:string) {
 const r=result;
 const lines=[
  `Metric evidence: ${r.metric.name}`,
  `Value: ${r.value??'Unavailable'} ${r.metric.unit}`,
  `Period (end exclusive): ${r.startsAt} — ${r.endsAt}`,
  `Reporting timezone: ${r.metric.timezone}`,
  `Quality: ${r.quality}`,
 ];
 if(r.metric.kind==='latest')lines.push(`Missing data: ${r.metric.missingData??'leave_gaps'}`,`Reporting policy revision: ${r.metric.reportingRevision??0}`,observationLabel(r,r.metric.timezone));
 if(r.interval)lines.push(`Interval: ${r.interval}`,`Aggregation: ${r.aggregation}`,`Storage resolution: ${r.resolution}`);
 if(r.comparison){
  const c=r.comparison;
  lines.push(
   `Comparison value: ${c.value??'Unavailable'} ${r.metric.unit}`,
   `Comparison period (end exclusive): ${c.startsAt} — ${c.endsAt}`,
   `Comparison quality: ${c.quality}`,
   `Absolute change: ${c.absolute??'Unavailable'} ${r.metric.unit}`,
   `Relative change: ${c.relative===null?'Unavailable':c.relative+'%'}`,
  );
  if(r.metric.kind==='latest')lines.push(`Comparison observations: ${observationLabel(c,r.metric.timezone)}`);
 }
 lines.push(`Metric key: ${r.metric.key}`,`Snapshot: ${snapshotId}`);
 return lines.join('\n');
}
