import {it,expect,vi,afterEach} from 'vitest';
import {ZbucketClient,ZbucketHttpError,WarehouseClient,WarehouseHttpError} from './server';
afterEach(()=>vi.unstubAllGlobals());
it('preserves status and Retry-After even when upstream error is not JSON',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('Too many requests',{status:429,headers:{'Retry-After':'19'}})));
 const client=new ZbucketClient('https://zbucket.example','synthetic');
 expect(WarehouseClient).toBe(ZbucketClient);expect(WarehouseHttpError).toBe(ZbucketHttpError);
 try{await client.events('web',1,[]);throw new Error('Expected rejection');}catch(error){expect(error).toBeInstanceOf(ZbucketHttpError);expect(error).toMatchObject({status:429,retryAfter:'19'});}
});
