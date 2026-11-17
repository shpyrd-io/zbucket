import {createHash} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import type pg from 'pg';
import {check} from '@/models/metrics/validation';
import {permissions,type Permissions} from '@/models/permissions';
import {accessMode,verifyIdentity} from './identity';
export type Principal={kind:'user';id:string;name:string;admin:boolean}|{kind:'integration';id:string;credentialId:string;sourceId:string;permissions:Permissions};
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function authenticate(pool:pg.Pool,req:Request):Promise<Principal>{
 const token=req.headers.get('authorization')??'';
 if(token.startsWith('Bearer wh_')){
  check(/^Bearer wh_[A-Za-z0-9_-]{43}$/.test(token),'Invalid integration credential.',401);
  const r=(await pool.query('SELECT a.*,c.id credential_id FROM warehouse_credentials c JOIN warehouse_apps a ON a.id=c.app_id WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND a.active',[digest(token.slice(7))])).rows[0];
  check(r,'Invalid, expired or revoked integration credential.',401);
  // Event publishing has an independent request budget and an event-volume budget.
  // All other operations retain the existing shared application quota.
  const publishing=req.method==='POST'&&['/api/v1/metrics/events','/api/v1/metrics/event-identify'].includes(new URL(req.url).pathname);
  if(publishing){
   const rate=(await pool.query(`INSERT INTO warehouse_event_rate_limits VALUES($1,date_trunc('minute',now()),1,0)
    ON CONFLICT(app_id) DO UPDATE SET window_start=date_trunc('minute',now()),
    requests=CASE WHEN warehouse_event_rate_limits.window_start=date_trunc('minute',now()) THEN warehouse_event_rate_limits.requests+1 ELSE 1 END,
    events=CASE WHEN warehouse_event_rate_limits.window_start=date_trunc('minute',now()) THEN warehouse_event_rate_limits.events ELSE 0 END RETURNING requests`,[r.id])).rows[0];
   check(rate.requests<=2400,'Event request limit reached. Retry next minute.',429);
  }else{
   const rate=(await pool.query(`INSERT INTO warehouse_rate_limits VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(app_id) DO UPDATE SET window_start=date_trunc('minute',now()),requests=CASE WHEN warehouse_rate_limits.window_start=date_trunc('minute',now()) THEN warehouse_rate_limits.requests+1 ELSE 1 END RETURNING requests`,[r.id])).rows[0];
   check(rate.requests<=240,'Integration rate limit reached. Retry next minute.',429);
  }
  await pool.query('UPDATE warehouse_credentials SET last_used_at=now() WHERE id=$1',[r.credential_id]);
  return {kind:'integration',id:r.id,sourceId:r.source_id,credentialId:r.credential_id,permissions:permissions(r.permissions)};
 }
 check(!/^Bearer (?:ct[im]_|wh_)/i.test(token),'Use a zbucket integration credential.',401);
 if(accessMode()==='local'){
  check(!token,'Invalid application credential.',401);
  check(['localhost','127.0.0.1','[::1]'].includes(new URL(req.url).hostname),'Local access is restricted to loopback.',403);
  const id='00000000-0000-7000-8000-000000000001';await pool.query("INSERT INTO warehouse_users VALUES($1,'local','developer','Local developer','developer@localhost') ON CONFLICT DO NOTHING",[id]);return {kind:'user',id,name:'Local developer',admin:true};
 }
 const identity=await verifyIdentity(req);
 const r=(await pool.query(`INSERT INTO warehouse_users VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email RETURNING id`,[uuid(),identity.issuer,identity.subject,identity.name,identity.email])).rows[0];
 return {kind:'user',id:r.id,name:identity.name,admin:identity.roles.includes('admin')};
}
export function human(p:Principal){check(p.kind==='user','A personal session is required.',403);return p;}
export function admin(p:Principal){const u=human(p);check(u.admin,'zbucket administrator access required.',403);return u;}
export function checkOrigin(req:Request,p:Principal){if(p.kind==='integration')return;const origin=req.headers.get('origin');check(!origin||allowedOrigin(origin,req),'Cross-origin request rejected.',403);check(req.headers.get('sec-fetch-site')!=='cross-site','Cross-site request rejected.',403);}
// The browser origin a mutation may come from: APP_ORIGIN when it is configured. Without it,
// an origin whose host is the request's own Host header. Behind Shpyrd's edge the Host is the
// public hostname while the hop to the application is plain HTTP, so the request URL's origin
// differs from the browser's by scheme alone; a cross-site page cannot choose the Host header,
// so comparing hosts is as strict as a configured origin. Forwarded headers are not consulted.
function allowedOrigin(origin:string,req:Request){const configured=process.env.APP_ORIGIN;if(configured)return origin===configured;const host=req.headers.get('host')??new URL(req.url).host;try{return new URL(origin).host===host;}catch{return false;}}
export async function audit(pool:Pick<pg.Pool,'query'>,p:Principal,action:string,target:string,status=200){await pool.query('INSERT INTO warehouse_audit(id,actor_id,action,target,status) VALUES($1,$2,$3,$4,$5)',[uuid(),p.id,action.slice(0,160),target.slice(0,200),status]);}

// Count submitted events (including retries) atomically across all replicas/credentials.
export async function chargeEventVolume(pool:pg.Pool,p:Principal,count:number){
 check(p.kind==='integration','Use an integration credential.',403);
 check(Number.isInteger(count)&&count>=1&&count<=1000,'Submit between 1 and 1,000 records.');
 const rate=(await pool.query(`INSERT INTO warehouse_event_rate_limits VALUES($1,date_trunc('minute',now()),0,$2)
 ON CONFLICT(app_id) DO UPDATE SET window_start=date_trunc('minute',now()),
 requests=CASE WHEN warehouse_event_rate_limits.window_start=date_trunc('minute',now()) THEN warehouse_event_rate_limits.requests ELSE 0 END,
 events=CASE WHEN warehouse_event_rate_limits.window_start=date_trunc('minute',now()) THEN warehouse_event_rate_limits.events+$2 ELSE $2 END RETURNING events`,[p.id,count])).rows[0];
 check(rate.events<=240000,'Event volume limit reached. Retry next minute.',429);
}
