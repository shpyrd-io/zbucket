import { describe,it,expect } from 'vitest';
import { metricChartSeries } from './chart';
import type { MetricResult } from './types';
const point=(startsAt:string,value:string|null)=>({startsAt,value,count:'1'});
function fixture():Pick<MetricResult,'metric'|'startsAt'|'endsAt'|'series'|'comparison'> {
 return {metric:{timezone:'UTC'} as MetricResult['metric'],startsAt:'2026-03-01T00:00:00Z',endsAt:'2026-04-01T00:00:00Z',
 series:[point('2026-03-01T00:00:00Z','12')],comparison:{startsAt:'2026-02-01T00:00:00Z',endsAt:'2026-03-01T00:00:00Z',value:'8',absolute:'4',relative:'50',quality:'complete',series:[point('2026-02-01T00:00:00Z','8'),point('2026-02-28T00:00:00Z','9')]}};
}
describe('Metric comparison chart',()=>{
 it('overlays by reporting day in Unix seconds without stretching February',()=>{const s=metricChartSeries(fixture());expect(s[0].points[0]).toEqual([Date.parse('2026-03-01T00:00:00Z')/1000,12]);expect(s[1].points).toEqual([[Date.parse('2026-03-01T00:00:00Z')/1000,8],[Date.parse('2026-03-28T00:00:00Z')/1000,9]]);});
 it('aligns local days across a DST transition',()=>{const r=fixture();r.metric.timezone='America/New_York';r.startsAt='2026-03-01T05:00:00Z';r.endsAt='2026-04-01T04:00:00Z';r.comparison!.startsAt='2026-02-01T05:00:00Z';r.comparison!.series=[point('2026-02-10T05:00:00Z','8')];expect(metricChartSeries(r)[1].points[0][0]).toBe(Date.parse('2026-03-10T04:00:00Z')/1000);});
 it('never fills missing values with zero or extends a shorter current range',()=>{const r=fixture();r.endsAt='2026-03-03T00:00:00Z';r.comparison!.series!.push(point('2026-02-02T00:00:00Z',null));expect(metricChartSeries(r)[1].points).toHaveLength(1);});
 it('supports no comparison and historical snapshots without series',()=>{const r=fixture();delete r.comparison!.series;expect(metricChartSeries(r)[1].points).toEqual([]);delete r.comparison;expect(metricChartSeries(r)).toHaveLength(1);});
});
