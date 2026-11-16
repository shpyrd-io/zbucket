import {WarehouseHttpError} from './server';
import {describe,it,expect,vi} from 'vitest';
import {createAnalyticsRelay} from './relay';
import type {Context} from './shared';
const origin='https://app.example';
function setup(){
 let identity:{userId:string;accountId?:string}|null=null;
 const client={events:vi.fn(async(_key:string,_version:number,_events:any[])=>({accepted:1})),identifyEventPerson:vi.fn(async(_key:string,_version:number,_anon:string,_user:string)=>({linked:true}))};
 const relay=createAnalyticsRelay({origin,client,datasetKey:'web',schemaVersion:1,signingSecret:'x'.repeat(32),resolveIdentity:async()=>identity,allowRequest:async()=>true});
 const send=(body:unknown,cookie='',requestOrigin=origin)=>relay(new Request(origin+'/analytics/events',{method:'POST',headers:{origin:requestOrigin,'content-type':'application/json',cookie},body:JSON.stringify(body)}));
 return {client,send,login:(v:typeof identity)=>{identity=v;}};
}
function event(context:Context){return {eventId:'web:00000000-0000-4000-8000-000000000001',occurredAt:new Date().toISOString(),name:'opened',sessionId:'00000000-0000-4000-8000-000000000002',properties:{feature:'reports'},context};}
describe('first-party relay',()=>{
 it('signs anonymous context, links after login and freezes account at capture time',async()=>{
  const s=setup(),r=await s.send({action:'context'}),anon=await r.json(),cookie=r.headers.get('set-cookie')!.split(';')[0];
  s.login({userId:'ana',accountId:'acme'});const identifiedResponse=await s.send({action:'context'},cookie),identified=await identifiedResponse.json();
  expect(s.client.identifyEventPerson).toHaveBeenCalledWith('web',1,anon.anonymousId,'user:ana');
  s.login({userId:'ana',accountId:'beta'});
  expect((await s.send({action:'capture',events:[event({...identified,userId:'mallory',accountId:'forged'})]})).status).toBe(202);
  expect(s.client.events.mock.calls[0]).toEqual(['web',1,[expect.objectContaining({data:expect.objectContaining({person:'user:ana',account:'acme'})})]]);
  expect((await s.send({action:'capture',events:[event(anon)]})).status).toBe(202);
  expect(s.client.events.mock.calls[1][2][0].data.person).toBe(anon.anonymousId);
 });
 it('rotates anonymous context between users and permits reset only after logout',async()=>{
  const s=setup();s.login({userId:'ana'});const r=await s.send({action:'context'}),a=await r.json(),cookie=r.headers.get('set-cookie')!.split(';')[0];
  expect((await s.send({action:'context',reset:true},cookie)).status).toBe(409);
  s.login({userId:'bruno'});const b=await(await s.send({action:'context'},cookie)).json();expect(b.anonymousId).not.toBe(a.anonymousId);
  s.login(null);const c=await(await s.send({action:'context',reset:true},cookie)).json();expect(c.userId).toBeNull();expect(c.anonymousId).not.toBe(a.anonymousId);
 });
 it('rejects cross origin, tampered contexts and oversized bodies before ingestion',async()=>{
  const s=setup();expect((await s.send({action:'context'},'','https://evil.example')).status).toBe(403);
  const c=await(await s.send({action:'context'})).json();c.token+='x';expect((await s.send({action:'capture',events:[event(c)]})).status).toBe(401);
  expect((await s.send({data:'a'.repeat(50000)})).status).toBe(413);expect(s.client.events).not.toHaveBeenCalled();
 });
 it('keeps transient failures retryable and rejects invalid properties',async()=>{
  const s=setup(),c=await(await s.send({action:'context'})).json();s.client.events.mockRejectedValueOnce(new Error('offline'));
  expect((await s.send({action:'capture',events:[event(c)]})).status).toBe(503);
  expect((await s.send({action:'capture',events:[{...event(c),properties:{nested:{secret:'x'}}}]})).status).toBe(422);
 });
});

it('preserves upstream quota and retry delay for capture and identity linking',async()=>{
 const s=setup(),context=await(await s.send({action:'context'})).json();
 s.client.events.mockRejectedValueOnce(new WarehouseHttpError(429,'Quota reached','17'));
 const r=await s.send({action:'capture',events:[event(context)]});expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toBe('17');
 s.login({userId:'ana'});s.client.identifyEventPerson.mockRejectedValueOnce(new WarehouseHttpError(429,'Quota reached','23'));
 const identity=await s.send({action:'context'});expect(identity.status).toBe(429);expect(identity.headers.get('retry-after')).toBe('23');
});
