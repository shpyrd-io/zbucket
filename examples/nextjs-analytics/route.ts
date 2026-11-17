// Copy into the application and supply its authenticated identity and rate limiter.
// The packaged equivalents are @shpyrd/zbucket-browser/{server,relay}.
import {ZbucketClient} from '../../sdk/javascript/src/server';
import {createAnalyticsRelay} from '../../sdk/javascript/src/relay';
export function analyticsRoute(config:{zbucketUrl:string;zbucketToken:string;signingSecret:string;origin:string;
 datasetKey:string;schemaVersion:number;
 resolveIdentity:(request:Request)=>Promise<{userId:string;accountId?:string|null}|null>;
 allowRequest:(request:Request)=>Promise<boolean>}){
 return createAnalyticsRelay({...config,client:new ZbucketClient(config.zbucketUrl,config.zbucketToken)});
}
