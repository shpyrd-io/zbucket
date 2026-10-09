import {expect,it} from 'vitest';
import {registration,metricPatch} from './registration';
import {permissions,emptyPermissions} from '../permissions';
const definition={key:'test_balance',name:'Balance',kind:'latest',unit:'BRL',inputMode:'measurements',dimensions:['account_id']};
it('keeps old permission documents default-deny and rejects non-boolean management flags',()=>{
 const old=structuredClone(emptyPermissions);delete (old.metrics as Partial<typeof old.metrics>).manageOwn;
 expect(permissions(old).metrics.manageOwn).toBe(false);
 for(const manageOwn of [null,'true',1])expect(()=>permissions({...old,metrics:{...old.metrics,manageOwn}})).toThrow();
});
it('binds publisher server-side and rejects identity or permission injection',()=>{
 expect(registration({definition},'source').definition.sourceId).toBe('source');
 for(const extra of [{sourceId:'other'},{ownerId:'other'},{version:2},{manageOwn:true},{arbitrary:'field'}])expect(()=>registration({definition:{...definition,...extra}},'source')).toThrow();
 expect(()=>registration({definition,permissions:{}},'source')).toThrow();
});
it('accepts only metadata patches with optimistic revision',()=>{
 expect(metricPatch({expectedRevision:2,changes:{name:'New name',maxSeries:500}}).changes.name).toBe('New name');
 for(const field of ['key','kind','unit','sourceId','dimensions','freshnessSeconds','storagePolicy','missingData','revision'])expect(()=>metricPatch({expectedRevision:1,changes:{[field]:'x'}})).toThrow('immutable');
 for(const expectedRevision of [undefined,null,0,'1',1.5])expect(()=>metricPatch({expectedRevision,changes:{name:'N'}})).toThrow();
 expect(()=>metricPatch({expectedRevision:1,changes:{}})).toThrow();
});
it('validates self-published event mappings and aggregate compatibility',()=>{
 const event={...definition,inputMode:'events'};
 expect(registration({definition:event,dataset:{schema:{value:'decimal',account_id:'string'}}},'source').dataset?.version).toBe(1);
 expect(()=>registration({definition:event,dataset:{schema:{value:'string',account_id:'string'}}},'source')).toThrow();
 expect(()=>registration({definition:{...definition,inputMode:'aggregates'}},'source')).toThrow('point observations');
 expect(()=>registration({definition,dataset:{schema:{value:'decimal'}}},'source')).toThrow();
});
