// Run the Python client through real HTTP handlers against an isolated local schema.
delete process.env.VOYAGE_API_KEY;
import pg from 'pg';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {emptyPermissions} from '../src/models/permissions';
const url=new URL(process.env.DATABASE_URL!),schema='warehouse_python_'+Date.now(),root=new pg.Pool({connectionString:url.toString()});
await root.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();process.env.ZBUCKET_ACCESS='local';
const routes=await import('../app/api/v1/[...operation]/route');
const {database}=await import('../src/server/database');
const {processMetricBatch}=await import('../src/server/metrics/worker');
const pool=await database();
async function admin(body:unknown){const r=await routes.POST(new Request('http://localhost/api/v1/integrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({operation:['integrations']})});if(r.status!==200)throw new Error('Fixture setup failed');return r.json();}
const server=createServer(async(req,res)=>{try{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const method=req.method as 'GET'|'POST'|'PATCH'|'DELETE',body=Buffer.concat(chunks),request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(body.length?{body}:{} )});
 if(!['GET','POST','PATCH','DELETE'].includes(method)){res.writeHead(405).end();return;}
 const response=await routes[method](request,{params:Promise.resolve({operation:new URL(request.url).pathname.replace('/api/v1/','').split('/')})});
 if(response.status===202)while(await processMetricBatch(pool)){}
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
 }catch{res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Acceptance fixture failed'}));}});
try{
 await admin({action:'collection',key:'sample',name:'SDK sample'});
 const app=await admin({action:'create',name:'Python acceptance',permissions:{...emptyPermissions,metrics:{...emptyPermissions.metrics,manageOwn:true,snapshots:true},knowledge:{readCollections:['sample'],writeCollections:['sample'],search:true,history:true,archive:true}}});
 const credential=await admin({action:'issue',id:app.id,days:1});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test port');
 const status=await new Promise<number|null>((resolve,reject)=>{
  const child=spawn(process.env.PYTHON||'python3',['sdk/python/tests/acceptance.py'],{env:{...process.env,PYTHONPATH:resolvePath(),ZBUCKET_URL:`http://127.0.0.1:${address.port}`,ZBUCKET_TOKEN:credential.secret},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>process.stdout.write(String(chunk).replaceAll(credential.secret,'<redacted>')));child.stderr.on('data',chunk=>process.stderr.write(String(chunk).replaceAll(credential.secret,'<redacted>')));child.on('error',reject);child.on('close',resolve);
 });if(status!==0)throw new Error('Python SDK acceptance failed');
}finally{
 await new Promise<void>(r=>server.close(()=>r()));await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
}
function resolvePath(){return resolve('sdk/python/src');}
