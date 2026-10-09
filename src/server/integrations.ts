import {randomBytes} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import type pg from 'pg';
import {permissions,emptyPermissions} from '@/models/permissions';
import {check,object,text} from '@/models/metrics/validation';
import {transaction} from './db/metrics';
import {admin,audit,digest,type Principal} from './access';
export async function integrations(pool:pg.Pool,p:Principal){admin(p);const [apps,credentials,collections,activity]=await Promise.all([pool.query('SELECT * FROM warehouse_apps ORDER BY name'),pool.query('SELECT id,app_id,expires_at,revoked_at,last_used_at,created_at FROM warehouse_credentials ORDER BY created_at DESC'),pool.query('SELECT * FROM knowledge_collections ORDER BY name'),pool.query('SELECT * FROM warehouse_audit ORDER BY created_at DESC LIMIT 100')]);return {apps:apps.rows,credentials:credentials.rows,collections:collections.rows,activity:activity.rows};}
export async function manageIntegration(pool:pg.Pool,p:Principal,input:unknown){admin(p);const b=object(input);return transaction(pool,async c=>{
 const action=text(b.action,'Action');let id=String(b.id??'');
 if(action==='collection'){const key=text(b.key,'Collection key',80);check(/^[a-z][a-z0-9-]*$/.test(key),'Invalid collection key.');await c.query('INSERT INTO knowledge_collections VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name',[key,text(b.name,'Name',120)]);await audit(c,p,action,key);return {key};}
 if(action==='create'||action==='update'){
  const grants=permissions(b.permissions??emptyPermissions),name=text(b.name,'Name',120);
  const keys=[...new Set([...grants.knowledge.readCollections,...grants.knowledge.writeCollections])];
  const found=await c.query('SELECT key FROM knowledge_collections WHERE key=ANY($1::text[])',[keys]);check(found.rowCount===keys.length,'Unknown knowledge collection.');
  if(action==='create'){id=uuid();const source=uuid();await c.query('INSERT INTO metric_sources(id,name,owner_id,active) VALUES($1,$2,$3,$4)',[source,name,p.id,b.active!==false]);await c.query('INSERT INTO warehouse_apps(id,name,source_id,permissions,active) VALUES($1,$2,$3,$4,$5)',[id,name,source,grants,b.active!==false]);}
  else {check(Number.isSafeInteger(b.revision),'Supply integration revision.');const r=await c.query('UPDATE warehouse_apps SET name=$2,permissions=$3,active=$4,revision=revision+1 WHERE id=$1 AND revision=$5 RETURNING source_id',[id,name,grants,b.active!==false,b.revision]);check(r.rowCount,'Integration changed. Reload before saving.',409);await c.query('UPDATE metric_sources SET name=$2,active=$3 WHERE id=$1',[r.rows[0].source_id,name,b.active!==false]);}
  await audit(c,p,action,id);return {id};
 }
 const app=(await c.query('SELECT * FROM warehouse_apps WHERE id=$1 FOR UPDATE',[id])).rows[0];check(app,'Integration not found.',404);
 if(action==='revoke'){const r=await c.query('UPDATE warehouse_credentials SET revoked_at=now() WHERE id=$1 AND app_id=$2 RETURNING id',[b.credentialId,id]);check(r.rowCount,'Credential not found.',404);await audit(c,p,action,id);return {revoked:true};}
 check(['issue','rotate'].includes(action),'Unknown integration action.');check(app.active,'Integration is disabled.',409);const days=Number(b.days??90);check(Number.isInteger(days)&&days>=1&&days<=365,'Expiry must be 1–365 days.');
 if(action==='rotate'){const r=await c.query('UPDATE warehouse_credentials SET revoked_at=now() WHERE id=$1 AND app_id=$2 AND revoked_at IS NULL RETURNING id',[b.credentialId,id]);check(r.rowCount,'Active credential not found.',404);}
 const secret='wh_'+randomBytes(32).toString('base64url'),credentialId=uuid(),expiresAt=new Date(Date.now()+days*86400000).toISOString();
 await c.query('INSERT INTO warehouse_credentials(id,app_id,secret_hash,expires_at) VALUES($1,$2,$3,$4)',[credentialId,id,digest(secret),expiresAt]);await audit(c,p,action,id);return {id:credentialId,secret,expiresAt};
});}
