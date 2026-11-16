// Node-only. Never include this entry point or the Warehouse credential in a browser bundle.
import {WarehouseHttpError} from './server.js';
import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {validProperties, type CaptureEvent} from './shared.js';
export {browserDatasetSchema, browserEventMapping} from './shared.js';
type Backend = {events(datasetKey:string,version:number,events:unknown[]):Promise<unknown>; identifyEventPerson(datasetKey:string,version:number,anonymousId:string,userId:string):Promise<unknown>};
type Options = {client:Backend; datasetKey:string; schemaVersion:number; signingSecret:string; origin:string;
 resolveIdentity:(request:Request)=>Promise<{userId:string;accountId?:string|null}|null>;
 /** Required admission control, e.g. an application's existing per-session/IP rate limiter. */
 allowRequest:(request:Request)=>Promise<boolean>;
 cookieName?:string; contextTtlSeconds?:number};
export function createAnalyticsRelay(options:Options){
 if(options.signingSecret.length<32)throw new Error('Use a dedicated random signing secret of at least 32 characters.');
 const origin=new URL(options.origin).origin,secure=new URL(origin).protocol==='https:',cookieName=options.cookieName??'warehouse_analytics';
 if(!/^[a-zA-Z0-9_]+$/.test(cookieName))throw new Error('Invalid cookie name.');
 const ttl=options.contextTtlSeconds??86400;
 if(!Number.isInteger(ttl)||ttl<60||ttl>86400)throw new Error('Context lifetime must be 60–86400 seconds.');
 const audience=JSON.stringify([origin,options.datasetKey,options.schemaVersion,cookieName]);
 const sign=(value:object)=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',options.signingSecret).update(audience+'.'+body).digest('base64url');};
 const verify=(token:string):Record<string,unknown>=>{
  const [body,sig,...rest]=token.split('.');if(!body||!sig||rest.length)throw new Error('Invalid context.');
  const expected=createHmac('sha256',options.signingSecret).update(audience+'.'+body).digest(),actual=Buffer.from(sig,'base64url');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Invalid context.');
  const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.expires<Date.now())throw new Error('Expired context.');return value;
 };
 const response=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
 const upstreamFailure=(error:unknown)=>{
  const status=error instanceof WarehouseHttpError?error.status:Number(/Warehouse HTTP (\d+)/.exec(String(error))?.[1]);
  const code=[400,403,409,413,422,429].includes(status)?status:503;
  const retryAfter=error instanceof WarehouseHttpError?error.retryAfter:null;
  return response({error:code===429?'Warehouse rate limit reached. Retry later.':'Warehouse rejected or could not accept this request.'},code,code===429?{'Retry-After':retryAfter??'60'}:{});
 };
 return async function handle(request:Request):Promise<Response>{
  if(request.method!=='POST')return response({error:'Use POST.'},405);
  if(request.headers.get('origin')!==origin)return response({error:'Origin denied.'},403);
  if(!await options.allowRequest(request))return response({error:'Rate limited.'},429,{'Retry-After':'10'});
  if(!request.headers.get('content-type')?.startsWith('application/json'))return response({error:'Use JSON.'},415);
  // Bound the stream before parsing; Content-Length is not trusted.
  let input:Record<string,unknown>;
  try{const reader=request.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>48*1024){await reader.cancel();return response({error:'Batch exceeds 48 KiB.'},413);}chunks.push(value);}input=JSON.parse(Buffer.concat(chunks).toString());if(!input||typeof input!=='object')throw new Error();}catch{return response({error:'Invalid JSON.'},400);}
  if(input.action==='context'){
   const identity=await options.resolveIdentity(request);
   if(identity&&(!identity.userId||identity.userId.length>190||identity.accountId!=null&&(!identity.accountId||identity.accountId.length>200)))return response({error:'Invalid server identity.'},500);
   if(input.reset&&identity)return response({error:'Log out before resetting analytics.'},409);
   let previous:Record<string,unknown>|undefined;
   try{const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));if(cookie)previous=verify(cookie.slice(cookieName.length+1));}catch{/* Expired cookies start a new anonymous journey. */}
   const userId=identity?'user:'+identity.userId:null;
   const anonymousId=!input.reset&&previous?.kind==='cookie'&&(!previous.userId||previous.userId===userId)?String(previous.anonymousId):'anon:'+randomUUID();
   if(userId){try{await options.client.identifyEventPerson(options.datasetKey,options.schemaVersion,anonymousId,userId);}catch(error){return upstreamFailure(error);}}
   const context={anonymousId,userId,accountId:identity?.accountId??null};
   const expiresAt=Date.now()+ttl*1000;const token=sign({...context,kind:'context',expires:expiresAt});
   const cookie=sign({anonymousId,userId,kind:'cookie',expires:Date.now()+365*86400000});
   return response({...context,token,expiresAt},200,{'Set-Cookie':`${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure?'; Secure':''}`});
  }
  if(input.action!=='capture'||!Array.isArray(input.events)||!input.events.length||input.events.length>20)return response({error:'Use 1–20 events.'},422);
  const records=[];
  for(const raw of input.events){
   const e=raw as CaptureEvent;let c:Record<string,unknown>;
   try{c=verify(e.context.token);if(c.kind!=='context')throw new Error();}catch{return response({error:'Refresh expired or invalid context.'},401);}
   if(typeof e.eventId!=='string'||!/^web:[a-f0-9-]{36}$/.test(e.eventId)||typeof e.name!=='string'||!e.name.trim()||e.name.length>200||typeof e.sessionId!=='string'||!/^[a-f0-9-]{36}$/.test(e.sessionId)||typeof e.occurredAt!=='string'||!Number.isFinite(Date.parse(e.occurredAt))||Date.parse(e.occurredAt)>Date.now()+300000||Date.parse(e.occurredAt)<Date.now()-86400000||!validProperties(e.properties))return response({error:'Invalid event.'},422);
   // Trust only the signed context, never user/account fields submitted by JavaScript.
   records.push({eventId:e.eventId,occurredAt:e.occurredAt,data:{name:e.name.trim(),person:c.userId??c.anonymousId,account:c.accountId,session:e.sessionId,properties:e.properties}});
  }
  try{const receipt=await options.client.events(options.datasetKey,options.schemaVersion,records);return response({accepted:records.length,receipt},202);}catch(error){
   return upstreamFailure(error);
  }
 };
}
