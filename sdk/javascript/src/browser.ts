import {retryAfterDelay,validProperties,type CaptureEvent,type Context,type Properties} from './shared.js';
export type BrowserOptions={endpoint:string;pageviews?:boolean;flushIntervalMs?:number;onError?:(message:string)=>void};
const SESSION_MS=30*60*1000,MAX_BYTES=40*1024;
export class WarehouseBrowser {
 private options!:BrowserOptions;private context:Context|null=null;private queue:CaptureEvent[]=[];private serial=Promise.resolve();private timer:ReturnType<typeof setInterval>|undefined;private sending=false;private stopped=false;private retries=0;private nextAttempt=0;private storageKey='';private session={id:'',last:0};private lastPath='';private cleanups:(()=>void)[]=[];
 private error(message:string){this.options.onError?.(message);}
 private enqueue(work:()=>Promise<void>){const result=this.serial.then(work);this.serial=result.catch(e=>this.error(String(e)));return result;}
 private save(){try{sessionStorage.setItem(this.storageKey,JSON.stringify({queue:this.queue,session:this.session}));}catch{/* Memory-only fallback. */}}
 private async refresh(reset=false){
  const r=await fetch(this.options.endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'context',reset})});
  if(!r.ok)throw new Error(`Analytics context HTTP ${r.status}`);this.context=await r.json();
 }
 async init(options:BrowserOptions){
  if(this.timer)throw new Error('Analytics is already initialized.');
  const endpoint=new URL(options.endpoint,location.href);if(endpoint.origin!==location.origin)throw new Error('Use a same-origin analytics relay.');
  this.options={...options,endpoint:endpoint.href};this.storageKey='warehouse:'+endpoint.pathname;this.stopped=false;
  try{this.stopped=localStorage.getItem(this.storageKey+':optout')==='1';}catch{}
  if(this.stopped)return;
  try{const saved=JSON.parse(sessionStorage.getItem(this.storageKey)??'null');if(saved&&Array.isArray(saved.queue)){this.queue=saved.queue.filter((e:CaptureEvent)=>e&&typeof e.eventId==='string'&&e.context?.token&&validProperties(e.properties)&&Date.parse(e.occurredAt)>Date.now()-86400000).slice(-200);if(saved.session?.id)this.session=saved.session;}}catch{/* Corrupt or unavailable storage. */}
  const ready=this.enqueue(()=>this.refresh());
  this.timer=setInterval(()=>{void this.flush();if(options.pageviews&&location.pathname!==this.lastPath)void this.page();},Math.max(1000,options.flushIntervalMs??5000));
  const hide=()=>{if(document.visibilityState==='hidden')void this.flush(true);};
  document.addEventListener('visibilitychange',hide);const unload=()=>{void this.flush(true);};window.addEventListener('pagehide',unload);
  this.cleanups.push(()=>document.removeEventListener('visibilitychange',hide),()=>window.removeEventListener('pagehide',unload));
  await ready;if(options.pageviews)await this.page();
 }
 identify(userId:string){return this.enqueue(async()=>{if(this.stopped)return;await this.refresh();if(this.context?.userId!=='user:'+userId)throw new Error('Analytics user must match the authenticated server session.');});}
 setAccount(accountId:string|null){return this.enqueue(async()=>{if(this.stopped)return;await this.refresh();if(this.context?.accountId!==accountId)throw new Error('Analytics account must match the active server account.');});}
 reset(){return this.enqueue(async()=>{await this.refresh(true);this.session={id:'',last:0};this.save();});}
 async track(name:string,properties:Properties={}){
  if(this.stopped)return;if(typeof name!=='string'||!name.trim()||name.length>200||!validProperties(properties))throw new Error('Invalid event name or properties.');
  const now=Date.now(),snapshot:Properties=JSON.parse(JSON.stringify(properties));
  return this.enqueue(async()=>{
  if(this.stopped)return;
  if(!this.context||this.context.expiresAt<Date.now()+60000)await this.refresh();
  if(now-this.session.last>=SESSION_MS||!this.session.id)this.session.id=crypto.randomUUID();this.session.last=now;
  const event:CaptureEvent={eventId:'web:'+crypto.randomUUID(),occurredAt:new Date(now).toISOString(),name,sessionId:this.session.id,properties:snapshot,context:{...this.context!}};
  if(new TextEncoder().encode(JSON.stringify({action:'capture',events:[event]})).length>MAX_BYTES)throw new Error('Event exceeds browser delivery budget.');
  this.queue.push(event);if(this.queue.length>200){this.queue.shift();this.error('Analytics queue full; oldest event dropped.');}this.save();if(this.queue.length>=20)void this.flush();
 });}
 page(){const path=location.pathname;this.lastPath=path;return this.track('page_viewed',{path});}
 async flush(keepalive=false){
  if(this.sending||this.stopped||!this.queue.length||Date.now()<this.nextAttempt)return;
  const expired=this.queue.filter(e=>e.context.expiresAt<=Date.now());if(expired.length){this.queue=this.queue.filter(e=>e.context.expiresAt>Date.now());this.error('Expired analytics contexts dropped from queue.');this.save();}
  if(!this.queue.length)return;
  this.sending=true;const batch:CaptureEvent[]=[];
  for(const e of this.queue.slice(0,20)){if(e.context.token!==this.queue[0].context.token)break;if(new TextEncoder().encode(JSON.stringify({action:'capture',events:[...batch,e]})).length>MAX_BYTES)break;batch.push(e);}
  try{
   if(!batch.length){this.queue.shift();this.error('Oversized queued event dropped.');return;}
   const response=await fetch(this.options.endpoint,{method:'POST',credentials:'same-origin',keepalive,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'capture',events:batch}),signal:AbortSignal.timeout(15000)});
   if(response.ok||response.status>=400&&response.status<500&&![408,429].includes(response.status)){
    const ids=new Set(batch.map(e=>e.eventId));this.queue=this.queue.filter(e=>!ids.has(e.eventId));this.retries=0;this.nextAttempt=0;
    if(!response.ok){this.error(`Analytics batch rejected (HTTP ${response.status}); removed from queue.`);if(response.status===401)this.context=null;}
   }else{this.retry(retryAfterDelay(response.headers.get('retry-after')));}
  }catch{this.retry();}finally{this.sending=false;this.save();}
 }
 private retry(delay=0){this.nextAttempt=Date.now()+Math.max(delay,Math.min(60000,1000*2**Math.min(this.retries++,6))*(0.8+Math.random()*0.4));}
 optOut(){try{localStorage.setItem(this.storageKey+':optout','1');}catch{}this.stopped=true;this.queue=[];this.context=null;this.save();}
 optIn(){try{localStorage.removeItem(this.storageKey+':optout');}catch{}this.stopped=false;if(!this.timer)return this.init(this.options);return this.enqueue(()=>this.refresh());}
 destroy(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.cleanups.forEach(fn=>fn());this.cleanups=[];}
}
export const warehouse=new WarehouseBrowser();
