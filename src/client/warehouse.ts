// Server-side SDK: never bundle an integration token into a browser application.
export class WarehouseClient {
 constructor(private baseUrl:string,private token:string){const u=new URL(baseUrl);if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new Error('Use HTTPS outside local development.');}
 async request<T>(path:string,body?:unknown):Promise<T>{const r=await fetch(this.baseUrl.replace(/\/$/,'')+'/api/v1/'+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(`Warehouse HTTP ${r.status}: ${data.error??'Request failed'}`);return data;}
 measurements(records:unknown[]){return this.request('metrics/measurements',{measurements:records});}
 query<T>(query:unknown){return this.request<T>('metrics/query',query);}
 saveDocument<T>(document:unknown){return this.request<T>('knowledge/documents',document);}
 search<T>(query:string,collection=''){return this.request<T>('knowledge/documents?'+new URLSearchParams({q:query,collection}));}
}
