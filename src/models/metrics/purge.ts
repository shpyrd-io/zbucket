import {check, instant, object, text} from './validation';

export type PurgeScope = {
  startsAt: string | null;
  endsAt: string | null;
  dimensions: Record<string, string>;
};
export type PurgePreview = {
  metricId: string;
  metricKey: string;
  timezone: string;
  scope: PurgeScope;
  fingerprint: string;
  counts: {
    measurements: number;
    records: number;
    pendingRecords: number;
    aggregateBuckets: number;
    coverageIntervals: number;
    dimensionCombinations: number;
  };
};
export type PurgeResult = PurgePreview & {id: string; completedAt: string};

export function purgeScope(input: unknown, declaredDimensions: string[]): PurgeScope {
  const value = object(input);
  const hasStart = value.startsAt !== undefined && value.startsAt !== null && value.startsAt !== '';
  const hasEnd = value.endsAt !== undefined && value.endsAt !== null && value.endsAt !== '';
  check(hasStart === hasEnd, 'Supply both start and exclusive end, or neither.');
  const startsAt = hasStart ? instant(value.startsAt) : null;
  const endsAt = hasEnd ? instant(value.endsAt) : null;
  check(!startsAt || endsAt! > startsAt, 'End must follow start.');
  const dimensions = object(value.dimensions ?? {});
  check(Object.keys(dimensions).every(key => declaredDimensions.includes(key)), 'Unknown dimension filter.');
  for (const [key, value] of Object.entries(dimensions)) {
    text(value, key, 200);
    check(value === String(value).trim(), 'Dimension values must match exactly, without surrounding whitespace.');
  }
  check(startsAt || Object.keys(dimensions).length, 'Choose a period or at least one dimension value.');
  return {startsAt, endsAt, dimensions: dimensions as Record<string, string>};
}
