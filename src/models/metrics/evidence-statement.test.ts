import {it,expect} from 'vitest';
import {metricEvidenceStatement} from './evidence-statement';
import type {MetricResult} from './types';
it('includes the saved comparison, coverage and zero change without recomputing it',()=>{
 const r={metric:{name:'Profit',unit:'USD',timezone:'UTC',version:1},value:'10',startsAt:'2026-09-01',endsAt:'2026-10-01',quality:'complete',comparison:{value:'10',startsAt:'2026-01-01',endsAt:'2026-02-01',quality:'partial',absolute:'0',relative:'0'}} as MetricResult;
 const s=metricEvidenceStatement(r,'snapshot');
 expect(s).toContain('Comparison period (end exclusive): 2026-01-01 — 2026-02-01');
 expect(s).toContain('Comparison quality: partial');expect(s).toContain('Relative change: 0%');
 r.comparison!.value=null;r.comparison!.relative=null;
 expect(metricEvidenceStatement(r,'snapshot')).toContain('Comparison value: Unavailable USD');
 delete r.comparison;expect(metricEvidenceStatement(r,'snapshot')).not.toContain('Comparison');
});
