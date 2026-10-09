import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { requireRule } from '@/models/policy';
export function accessMode() {
 const configured=process.env.WAREHOUSE_ACCESS;
 requireRule(!configured||['local','shpyrd'].includes(configured),'Invalid access mode.',503);
 const platform=!!(process.env.SHPYRD_ISSUER||process.env.SHPYRD_PROJECT||process.env.SHPYRD_WORKSPACE);
 if(platform||configured==='shpyrd')return 'shpyrd';
 requireRule(process.env.NODE_ENV!=='production','Production access is not configured.',503);
 return 'local';
}
export function identityConfiguration(){
 const issuer=process.env.SHPYRD_ISSUER?.replace(/\/$/,''),project=process.env.SHPYRD_PROJECT,workspace=process.env.SHPYRD_WORKSPACE;
 requireRule(issuer&&project&&workspace,'Shpyrd identity is not configured.',503);
 const url=new URL(issuer);
 requireRule(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'Shpyrd issuer must use HTTPS.',503);
 return {issuer,project,workspace};
}
const resolvers=new Map<string,JWTVerifyGetKey>();
export async function verifyIdentity(request:Request,keys?:JWTVerifyGetKey){
 const config=identityConfiguration();
 const raw=request.headers.get('authorization')??'';
 requireRule(!/^bearer\s+(?:wh_|ct[im]_)/i.test(raw),'Application credentials must use the integrations API.',403);
 const token=/^Bearer ([^\s]+)$/i.exec(raw)?.[1];
 requireRule(token&&token.length<16384,'Sign in through shpyrd.',401);
 if(!keys){keys=resolvers.get(config.issuer);if(!keys){keys=createRemoteJWKSet(new URL(config.issuer+'/.well-known/jwks.json'),{timeoutDuration:5000});resolvers.set(config.issuer,keys);}}
 let payload:JWTPayload;
 try {({payload}=await jwtVerify(token,keys,{issuer:config.issuer,audience:config.project,algorithms:['EdDSA'],typ:'JWT',requiredClaims:['sub','exp','iat'],maxTokenAge:'6m',clockTolerance:30}));}
 catch {requireRule(false,'Invalid or expired Shpyrd session.',401);}
 requireRule(payload.ws===config.workspace&&payload.project===config.project,'Wrong Shpyrd workspace or project.',403);
 requireRule(payload.realm==='workspace'&&typeof payload.provider==='string'&&!!payload.provider&&!['api-token','token','system'].includes(payload.provider)&&!payload.preview&&!payload.act&&!payload.operator,'A personal Shpyrd session is required.',403);
 requireRule(typeof payload.sub==='string'&&payload.sub.length>0,'Missing Shpyrd identity.',401);
 const roles:string[]=Array.isArray(payload.roles)?payload.roles.filter((r:unknown):r is string=>typeof r==='string'):[];
 requireRule(roles.some(r=>['user','viewer','developer','admin'].includes(r)),'Project membership is required.',403);
 requireRule(typeof payload.email==='string'&&payload.email.includes('@')&&payload.email.length<=320,'A user email is required.',403);
 return {issuer:config.issuer,subject:payload.sub,email:payload.email.trim().toLowerCase(),name:typeof payload.name==='string'&&payload.name.trim()?payload.name.trim().slice(0,300):payload.email,roles};
}
