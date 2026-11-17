import {afterEach,expect,it,vi} from 'vitest';
import {checkOrigin,type Principal} from './access';
const user:Principal={kind:'user',id:'user-1',name:'Test user',admin:true};
afterEach(()=>vi.unstubAllEnvs());
it('accepts the configured public origin behind the Shpyrd reverse proxy',()=>{
 vi.stubEnv('APP_ORIGIN','https://platform-warehouse.shpyrd.app');
 expect(()=>checkOrigin(new Request('http://0.0.0.0:8080/api/v1/knowledge/documents',{method:'POST',headers:{origin:'https://platform-warehouse.shpyrd.app','sec-fetch-site':'same-origin'}}),user)).not.toThrow();
});
it('rejects other origins and does not trust forwarded headers to choose the public origin',()=>{
 vi.stubEnv('APP_ORIGIN','https://platform-warehouse.shpyrd.app');
 expect(()=>checkOrigin(new Request('http://0.0.0.0:8080/api/v1/knowledge/documents',{method:'POST',headers:{origin:'https://other.example','x-forwarded-host':'other.example','x-forwarded-proto':'https'}}),user)).toThrow('Cross-origin');
 expect(()=>checkOrigin(new Request('http://0.0.0.0:8080/api/v1/knowledge/documents',{method:'POST',headers:{origin:'https://platform-warehouse.shpyrd.app','sec-fetch-site':'cross-site'}}),user)).toThrow('Cross-site');
});
it('accepts the browser origin whose host is the request host when no public origin is configured',()=>{
 vi.stubEnv('APP_ORIGIN','');
 const headers={host:'platform-zbucket.shpyrd.app',origin:'https://platform-zbucket.shpyrd.app','sec-fetch-site':'same-origin'};
 expect(()=>checkOrigin(new Request('http://platform-zbucket.shpyrd.app/api/v1/knowledge/documents',{method:'POST',headers}),user)).not.toThrow();
 expect(()=>checkOrigin(new Request('http://platform-zbucket.shpyrd.app/api/v1/knowledge/documents',{method:'POST',headers:{...headers,origin:'https://other.example','x-forwarded-host':'other.example'}}),user)).toThrow('Cross-origin');
 expect(()=>checkOrigin(new Request('http://platform-zbucket.shpyrd.app/api/v1/knowledge/documents',{method:'POST',headers:{...headers,origin:'null'}}),user)).toThrow('Cross-origin');
});
it('retains the request origin for local development',()=>{
 vi.stubEnv('APP_ORIGIN','');
 expect(()=>checkOrigin(new Request('http://localhost:4332/api/v1/knowledge/documents',{method:'POST',headers:{origin:'http://localhost:4332'}}),user)).not.toThrow();
});
