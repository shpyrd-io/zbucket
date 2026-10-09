import type { MetricDefinition } from './types';
import { canonical, check } from './validation';

// Reporting policy is edited separately. Everything outside this allowlist is immutable.
export const metricMetadataFields = ['name', 'description', 'category', 'status', 'direction', 'maxSeries'] as const;
export function metricContract(value: MetricDefinition) {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of [...metricMetadataFields, 'missingData']) delete copy[key];
  // Dimension order does not change the identity of a series.
  copy.dimensions = [...value.dimensions].sort();
  return copy;
}
export function assertMetricContract(previous: MetricDefinition, next: MetricDefinition) {
  const before = metricContract(previous), after = metricContract(next);
  const changed = Object.keys(before).filter(key => canonical(before[key]) !== canonical(after[key]));
  check(!changed.length, `Metric definition is immutable. Cannot change: ${changed.join(', ')}. Create a metric with a new key for a different contract.`, 409);
  check((previous.missingData ?? 'leave_gaps') === (next.missingData ?? 'leave_gaps'), 'Edit missing-data behavior through Reporting policy.', 409);
}
