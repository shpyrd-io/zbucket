import { assertMetricContract } from './definition-contract';
import { describe,it,expect } from 'vitest';
import { definition,decimal,dimensionValues,canonical } from './validation';
import { localInstant,metricPeriod,previousMonth } from './calendar';
const base={key:'revenue',name:'Revenue',kind:'sum',unit:'BRL',sourceId:'source',inputMode:'events'};
describe('Metric contracts',()=>{
 it('allows metadata edits but rejects a changed measurement contract',()=>{
  const original=definition({...base,dimensions:['account_id','bank']});
  expect(()=>assertMetricContract(original,definition({...original,name:'Renamed',category:'Finance',direction:'higher',status:'paused',maxSeries:12000,dimensions:['bank','account_id']}))).not.toThrow();
  for(const change of [{unit:'USD'},{kind:'mean'},{sourceId:'another'},{key:'new_key'},{timezone:'America/Sao_Paulo'},{dimensions:['account_id']},{valueField:'other'},{freshnessSeconds:3600}])
   expect(()=>assertMetricContract(original,definition({...original,...change}))).toThrow(/immutable/);
 });
 it('keeps missing-data policy on its audited reporting endpoint',()=>{
  const original=definition({...base,kind:'latest'});
  expect(()=>assertMetricContract(original,{...original,missingData:'keep_previous'})).toThrow(/Reporting policy/);
 });
 it('preserves strict gaps by default and allows carry-forward only for snapshots',()=>{
  expect(definition(base).missingData).toBe('leave_gaps');
  expect(definition({...base,kind:'latest',missingData:'keep_previous'}).missingData).toBe('keep_previous');
  expect(()=>definition({...base,missingData:'keep_previous'})).toThrow(/snapshot/);
  expect(()=>definition({...base,kind:'latest',missingData:'zero'})).toThrow(/Choose/);
 });
 it('rejects scalar nonmergeable aggregate states',()=>{for(const kind of ['distinct','p95'])expect(()=>definition({...base,kind,inputMode:'aggregates'})).toThrow(/cannot be merged/);});
 it('never uses a floating number as financial evidence',()=>{expect(()=>decimal(.1)).toThrow();expect(decimal('0.100000000001')).toBe('0.100000000001');});
 it('requires explicit bounded dimension sets',()=>{expect(()=>dimensionValues({channel:'all',customer:'x'},['channel'])).toThrow();expect(()=>definition({...base,dimensions:Array.from({length:9},(_,i)=>'d'+i)})).toThrow();});
 it('canonicalizes identity without depending on JSON key order',()=>expect(canonical({b:2,a:{z:1,x:2}})).toBe(canonical({a:{x:2,z:1},b:2})));
 it('retains draft state until activated',()=>expect(definition(base).status).toBe('draft'));
 it('does not interpret arbitrary formulas as executable code',()=>expect(()=>definition({...base,kind:'eval',valueField:'process.exit()'})).toThrow());
 it('rejects invalid timezone and unsafe keys',()=>{expect(()=>definition({...base,timezone:'Not/AZone'})).toThrow();expect(()=>definition({...base,key:'DROP TABLE'})).toThrow();});
});
describe('Metric reporting calendar',()=>{
 it('opens two calendar years without losing leap days',()=>expect(metricPeriod('last_2_years','UTC',new Date('2025-10-06T12:00:00Z'))).toEqual({startsAt:'2023-10-06T00:00:00.000Z',endsAt:'2025-10-06T12:00:00.000Z'}));
 it('uses a 23-hour day on spring DST transition',()=>expect(Date.parse(localInstant(2026,3,9,'America/New_York'))-Date.parse(localInstant(2026,3,8,'America/New_York'))).toBe(23*3600000));
 it('handles fractional timezone offsets',()=>expect(localInstant(2026,10,6,'Asia/Kathmandu')).toBe('2026-10-05T18:15:00.000Z'));
 it('uses Monday for complete weeks',()=>expect(metricPeriod('last_week','UTC',new Date('2026-10-06T12:00:00Z'))).toEqual({startsAt:'2026-09-28T00:00:00.000Z',endsAt:'2026-10-05T00:00:00.000Z'}));
 it('supports fiscal-year boundaries in the calendar model',()=>expect(metricPeriod('ytd','UTC',new Date('2026-02-06T12:00:00Z'),1,4).startsAt).toBe('2025-04-01T00:00:00.000Z'));
 it('starts MTD in the reporting timezone',()=>expect(metricPeriod('mtd','America/Sao_Paulo',new Date('2026-10-06T12:00:00Z')).startsAt).toBe('2026-10-01T03:00:00.000Z'));
 it('clamps previous month rather than overflowing February',()=>expect(previousMonth('2026-03-01T00:00:00Z','2026-03-31T12:00:00Z','UTC').compareEndsAt).toBe('2026-02-28T12:00:00.000Z'));
});
