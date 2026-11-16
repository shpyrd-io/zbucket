// Copy into the application and supply its authenticated identity and rate limiter.
// The packaged equivalents are @shpyrd/warehouse-browser/{server,relay}.
import {WarehouseClient} from '../../sdk/javascript/src/server';
import {createAnalyticsRelay} from '../../sdk/javascript/src/relay';
export function analyticsRoute(config:{warehouseUrl:string;warehouseToken:string;signingSecret:string;origin:string;
 datasetKey:string;schemaVersion:number;
 resolveIdentity:(request:Request)=>Promise<{userId:string;accountId?:string|null}|null>;
 allowRequest:(request:Request)=>Promise<boolean>}){
 return createAnalyticsRelay({...config,client:new WarehouseClient(config.warehouseUrl,config.warehouseToken)});
}
