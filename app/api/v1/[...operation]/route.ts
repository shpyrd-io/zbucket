import {database} from '@/server/database';
import {authenticate,admin,checkOrigin,audit,type Principal} from '@/server/access';
import {integrations,manageIntegration} from '@/server/integrations';
import {manageMetric} from '@/server/metric-management';
import {metricGet,metricPost} from '@/server/metric-api';
import {knowledgeList,documentGet,saveDocument} from '@/server/knowledge';
import {DomainError} from '@/models/policy';
import {check,object,text} from '@/models/metrics/validation';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{operation:string[]}>};
async function readBody(req:Request){check(req.headers.get('content-type')?.includes('application/json'),'Use application/json.',415);const reader=req.body?.getReader();check(reader,'JSON body required.');const chunks:Uint8Array[]=[];let size=0;while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>5*1024*1024){await reader.cancel();check(false,'Request exceeds 5 MiB.',413);}chunks.push(r.value);}try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){if(e instanceof SyntaxError)throw new DomainError(400,'Invalid JSON.');throw e;}}
async function run(req:Request,ctx:Context){let principal:Principal|undefined;const parts=(await ctx.params).operation;try{const pool=await database();principal=await authenticate(pool,req);const [area,op,id,sub]=parts;const params=new URL(req.url).searchParams;let result:unknown;
 if(req.method==='GET'){
  if(area==='session'){check(principal.kind==='user','Personal session required.',403);result=principal;}
  else if(area==='integrations')result=await integrations(pool,principal);
  else if(area==='metrics')result=await metricGet(pool,principal,parts.slice(1),params);
  else if(area==='knowledge'&&op==='documents'){
   check(parts.length<=4&&(!sub||sub==='history'),'Endpoint not found.',404);
   result=id?await documentGet(pool,principal,id==='by-key'?{collection:text(params.get('collection'),'Collection',80),key:text(params.get('key'),'Document key',200)}:id,sub==='history'):await knowledgeList(pool,principal,params);
  }
  else check(false,'Endpoint not found.',404);
 }else{
  checkOrigin(req,principal);const body=await readBody(req);
  if(area==='metrics'&&op==='definitions'&&(principal.kind==='integration'||req.method!=='POST')){check(parts.length<=3,'Endpoint not found.',404);result=await manageMetric(pool,principal,req.method,id,body);}
  else if(req.method!=='POST')check(false,'Method not allowed.',405);
  else if(area==='integrations')result=await manageIntegration(pool,principal,body);
  else if(area==='metrics')result=await metricPost(pool,principal,parts.slice(1),body,req);
  else if(area==='knowledge'&&op==='documents'){check(id!=='by-key','Method not allowed.',405);result=await saveDocument(pool,principal,{...body,...(id?{id}:{})});}
  else if(area==='knowledge'&&op==='reindex'){admin(principal);await pool.query("UPDATE knowledge_documents SET index_status='pending',index_attempts=0 WHERE active");result={queued:true};}
  else check(false,'Endpoint not found.',404);
 }
 const status=result instanceof Response?result.status:area==='metrics'&&op==='definitions'&&principal.kind==='integration'&&req.method==='POST'&&(result as {created?:boolean})?.created?201:req.method==='POST'&&area==='metrics'&&['events','measurements','aggregates','corrections'].includes(op)?202:200;
 if(principal.kind==='integration')await audit(pool,principal,req.method+' '+area+'/'+(op??''),id??'',status);
 if(result instanceof Response)return result;
 return Response.json(result,{status,headers:{'Cache-Control':'no-store'}});
 }catch(e){const code=(e as {code?:string})?.code,status=e instanceof DomainError?e.status:code==='23505'?409:code==='22P02'?400:500;const message=e instanceof DomainError?e.message:status===409?'This key or name already exists.':status===400?'Invalid identifier or value.':'zbucket request failed.';
 if(principal?.kind==='integration')try{await audit(await database(),principal,req.method+' '+parts.slice(0,2).join('/'),'',status);}catch{}
 if(status===500)console.error('zbucket request failed:',e instanceof Error?e.name:'Unknown error');
 return Response.json({error:message},{status,headers:{'Cache-Control':'no-store',...(status===429?{'Retry-After':'60'}:{})}});
 }}
export const GET=run;export const POST=run;export const PATCH=run;export const DELETE=run;
