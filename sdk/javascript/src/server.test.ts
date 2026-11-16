import {it,expect,vi,afterEach} from 'vitest';
import {WarehouseClient,WarehouseHttpError} from './server';
afterEach(()=>vi.unstubAllGlobals());
it('preserves status and Retry-After even when upstream error is not JSON',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('Too many requests',{status:429,headers:{'Retry-After':'19'}})));
 const client=new WarehouseClient('https://warehouse.example','synthetic');
 try{await client.events('web',1,[]);throw new Error('Expected rejection');}catch(error){expect(error).toBeInstanceOf(WarehouseHttpError);expect(error).toMatchObject({status:429,retryAfter:'19'});}
});
