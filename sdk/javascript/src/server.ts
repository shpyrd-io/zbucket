// Server-side SDK: never bundle an integration token into a browser application.
export class ZbucketHttpError extends Error {
 constructor(public status:number,message:string,public retryAfter:string|null=null){super(`zbucket HTTP ${status}: ${message}`);this.name='ZbucketHttpError';}
}
export class ZbucketClient {
 constructor(private baseUrl:string,private token:string){const u=new URL(baseUrl);if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new Error('Use HTTPS outside local development.');}
 async request<T>(path:string,body?:unknown):Promise<T>{const r=await fetch(this.baseUrl.replace(/\/$/,'')+'/api/v1/'+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${this.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(!r.ok)throw new ZbucketHttpError(r.status,data.error??'Request failed',r.headers.get('retry-after'));return data;}
 events(datasetKey:string,schemaVersion:number,events:unknown[]){return this.request('metrics/events',{datasetKey,schemaVersion,events});}
 identifyEventPerson(datasetKey:string,schemaVersion:number,anonymousId:string,userId:string){return this.request('metrics/event-identify',{datasetKey,schemaVersion,anonymousId,userId});}
 eventTimeline<T>(query:unknown){return this.request<T>('metrics/event-timeline',query);}
 eventFunnel<T>(query:unknown){return this.request<T>('metrics/event-funnel',query);}
 measurements(records:unknown[]){return this.request('metrics/measurements',{measurements:records});}
 query<T>(query:unknown){return this.request<T>('metrics/query',query);}
 saveDocument<T>(document:unknown){return this.request<T>('knowledge/documents',document);}
 search<T>(query:string,collection=''){return this.request<T>('knowledge/documents?'+new URLSearchParams({q:query,collection}));}
}
// Preserve instanceof and existing server consumers during the rename.
export {ZbucketClient as WarehouseClient,ZbucketHttpError as WarehouseHttpError};
