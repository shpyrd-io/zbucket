import {it,expect,vi,afterEach} from 'vitest';
import {WarehouseBrowser} from './browser';
const instances:WarehouseBrowser[]=[];
function setup(){
 const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>data.delete(k)};
 vi.stubGlobal('sessionStorage',storage);vi.stubGlobal('localStorage',storage);
 vi.stubGlobal('location',{href:'https://app.example/home?secret=hidden',origin:'https://app.example',pathname:'/home'});
 vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
 let userId:string|null=null,accountId:string|null=null;const calls:any[]=[];let fail=false;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));if(body.action==='context')return Response.json({anonymousId:'anon:one',userId,accountId,token:'signed-'+accountId,expiresAt:Date.now()+86400000});calls.push(body);return new Response(null,{status:fail?503:202});}));
 const sdk=new WarehouseBrowser();instances.push(sdk);return {sdk,calls,fail:(v:boolean)=>{fail=v;},identity:(user:string,account:string)=>{userId='user:'+user;accountId=account;}};
}
afterEach(()=>{instances.splice(0).forEach(s=>s.destroy());vi.unstubAllGlobals();vi.useRealTimers();});
it('queues frozen identity, retains event IDs on retry, and excludes URL query strings',async()=>{
 vi.useFakeTimers();const s=setup();await s.sdk.init({endpoint:'/analytics/events',pageviews:true});await s.sdk.flush();s.identity('ana','acme');await s.sdk.identify('ana');await s.sdk.track('feature_used',{feature:'reports'});s.identity('ana','beta');await s.sdk.setAccount('beta');
 s.fail(true);await s.sdk.flush();expect(s.calls[0].events[0].properties).toEqual({path:'/home'});expect(s.calls[1].events[0].context.accountId).toBe('acme');
 s.fail(false);vi.setSystemTime(Date.now()+70000);await s.sdk.flush();expect(s.calls[2]).toEqual(s.calls[1]);
 await s.sdk.flush();expect(s.calls).toHaveLength(3);
});
it('expires sessions on inactivity and clears capture on opt out',async()=>{
 vi.useFakeTimers();const s=setup();await s.sdk.init({endpoint:'/analytics/events'});await s.sdk.track('first');await s.sdk.flush();vi.setSystemTime(Date.now()+31*60000);await s.sdk.track('second');await s.sdk.flush();expect(s.calls[0].events[0].sessionId).not.toBe(s.calls[1].events[0].sessionId);
 await s.sdk.track('discard');s.sdk.optOut();await s.sdk.track('ignored');await s.sdk.flush();expect(s.calls).toHaveLength(2);
});
it('rejects forged identity and invalid nested properties',async()=>{
 const s=setup();await s.sdk.init({endpoint:'/analytics/events'});await expect(s.sdk.identify('forged')).rejects.toThrow('authenticated');await expect(s.sdk.track('bad',{nested:{} as string})).rejects.toThrow('Invalid');
});

it.each(['60','Sun, 15 Nov 2026 00:01:00 GMT'])('honors Retry-After %s without losing or changing the queued event',async retryAfter=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));const s=setup();await s.sdk.init({endpoint:'/analytics/events'});await s.sdk.track('retry_me');
 const bodies:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{bodies.push(String(init.body));return bodies.length===1?new Response(null,{status:429,headers:{'Retry-After':retryAfter}}):new Response(null,{status:202});}));
 await s.sdk.flush();vi.setSystemTime(Date.now()+59000);await s.sdk.flush();expect(bodies).toHaveLength(1);
 vi.setSystemTime(Date.now()+1001);await s.sdk.flush();expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);await s.sdk.flush();expect(bodies).toHaveLength(2);
});
