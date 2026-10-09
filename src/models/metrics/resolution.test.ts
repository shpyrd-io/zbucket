import {describe,it,expect} from 'vitest';
import {storagePolicy,estimateStates} from './resolution';
import {definition} from './validation';
const p={baseResolution:'minute',baseRetentionDays:7,hourRetentionDays:30,dayRetentionDays:365,rawRetentionDays:3};
describe('metric storage contracts',()=>{
 it('keeps legacy definitions opt-in',()=>expect(storagePolicy(undefined,'sum')).toBeUndefined());
 it('rejects scalar percentile/distinct compaction',()=>{for(const kind of ['distinct','p95'] as const)expect(()=>storagePolicy(p,kind)).toThrow('raw detail');});
 it('rejects increasing detail retention and fractional days',()=>{expect(()=>storagePolicy({...p,rawRetentionDays:8},'sum')).toThrow('Raw retention');expect(()=>storagePolicy({...p,dayRetentionDays:1},'sum')).toThrow('increase');expect(()=>storagePolicy({...p,baseRetentionDays:1.5},'sum')).toThrow('between');});
 it('estimates states by actual series, not a cross product of every possible dimension',()=>{const v=storagePolicy(p,'sum')!;expect(estimateStates(v,1000).total).toBe((7*1440+30*24+365)*1000);});
 it('requires UTC base buckets to tile the reporting calendar',()=>{const base={key:'balance',name:'Balance',sourceId:'source',kind:'latest',inputMode:'measurements',unit:'USD',timezone:'Asia/Kolkata'};expect(()=>definition({...base,storagePolicy:{...p,baseResolution:'hour',baseRetentionDays:30}})).toThrow('align');expect(definition({...base,storagePolicy:p}).storagePolicy?.baseResolution).toBe('minute');});
});
