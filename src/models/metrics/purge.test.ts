import {describe,it,expect} from 'vitest';
import {purgeScope} from './purge';
describe('purge selection',()=>{
 it('requires a real scope and a complete dated interval',()=>{
  for(const value of [{},{dimensions:{}},{startsAt:'2026-10-01T00:00:00Z'},{endsAt:'2026-10-01T00:00:00Z'},{startsAt:'2026-10-02T00:00:00Z',endsAt:'2026-10-01T00:00:00Z'}])expect(()=>purgeScope(value,['account_id'])).toThrow();
 });
 it('accepts exact dimension subsets, not undeclared or blank values',()=>{
  expect(purgeScope({dimensions:{account_id:'A'}},['account_id','bank'])).toEqual({startsAt:null,endsAt:null,dimensions:{account_id:'A'}});
  for(const dimensions of [{account_id:''},{account_id:' A'},{unknown:'A'},{account_id:5}])expect(()=>purgeScope({dimensions},['account_id'])).toThrow();
 });
 it('normalizes timestamps and retains end-exclusive semantics',()=>{
  expect(purgeScope({startsAt:'2026-10-01T00:00:00-03:00',endsAt:'2026-10-02T00:00:00-03:00'},[])).toEqual({startsAt:'2026-10-01T03:00:00.000Z',endsAt:'2026-10-02T03:00:00.000Z',dimensions:{}});
 });
});
