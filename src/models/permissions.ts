import {check,object} from './metrics/validation';
export type Permissions={metrics:{manageOwn:boolean;read:string[];write:string[];dimensions:Record<string,Record<string,string>>;snapshots:boolean};knowledge:{readCollections:string[];writeCollections:string[];search:boolean;history:boolean;archive:boolean}};
export const emptyPermissions:Permissions={metrics:{manageOwn:false,read:[],write:[],dimensions:{},snapshots:false},knowledge:{readCollections:[],writeCollections:[],search:false,history:false,archive:false}};
export function permissions(input:unknown):Permissions{
 const root=object(input),m=object(root.metrics),k=object(root.knowledge);
 const list=(v:unknown)=>{check(Array.isArray(v)&&v.length<=500&&v.every(x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/.test(x)),'Use explicit metric keys and collection keys; wildcards are not supported.');return [...new Set(v)] as string[];};
 const bool=(v:unknown)=>{check(typeof v==='boolean','Permission flags must be boolean.');return v;};
 const read=list(m.read),write=list(m.write),scopes=object(m.dimensions);
 for(const [key,value]of Object.entries(scopes)){check(read.includes(key)||write.includes(key),'Dimension scope requires a metric grant.');const scope=object(value);check(Object.keys(scope).length<=20&&Object.entries(scope).every(([k,v])=>/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(k)&&typeof v==='string'&&v.length>0&&v.length<=300),'Invalid dimension scope.');}
 return {metrics:{manageOwn:bool(m.manageOwn===undefined?false:m.manageOwn),read,write,dimensions:scopes as Permissions['metrics']['dimensions'],snapshots:bool(m.snapshots)},knowledge:{readCollections:list(k.readCollections),writeCollections:list(k.writeCollections),search:bool(k.search),history:bool(k.history),archive:bool(k.archive)}};
}
export function scopedDimensions(p:Permissions,key:string,value:unknown={},mode:'read'|'write'='read'){
 check(p.metrics[mode].includes(key),'Metric access denied.',403);const requested=object(value),scope=p.metrics.dimensions[key]??{};
 check(Object.entries(requested).every(([k,v])=>typeof k==='string'&&typeof v==='string'),'Invalid dimensions.');
 check(Object.entries(scope).every(([k,v])=>requested[k]===v||(mode==='read'&&requested[k]===undefined)),'Dimensions exceed the integration scope.',403);
 return {...requested,...scope} as Record<string,string>;
}
