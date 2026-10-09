import { resolutionSeconds, storagePolicy } from './resolution';
import { DomainError } from '../policy';
import { metricKinds, type MetricDefinition } from './types';
export function check(value:unknown,message:string,status=422):asserts value {if(!value)throw new DomainError(status,message);}
export function object(value:unknown):Record<string,unknown>{check(value&&typeof value==='object'&&!Array.isArray(value),'Expected an object.');return value as Record<string,unknown>;}
export function text(value:unknown,label:string,max=200){check(typeof value==='string'&&value.trim().length>0&&value.length<=max,`${label} is required (maximum ${max} characters).`);return value.trim();}
export function instant(value:unknown){const s=text(value,'Timestamp',40);check(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)),'Use an ISO timestamp with timezone.');return new Date(s).toISOString();}
export function decimal(value:unknown){check(typeof value==='string'&&/^-?\d{1,24}(\.\d{1,12})?$/.test(value),'Use a decimal string with at most 24 integer and 12 fractional digits.');return value;}
export function canonical(value:unknown,depth=0):string {check(depth<=20,'Payload nesting exceeds 20 levels.');if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v,depth+1)).join(',')+'}';return JSON.stringify(value);}
export function definition(input:unknown):MetricDefinition {
 const d=object(input);const key=text(d.key,'Key',100);check(/^[a-z][a-z0-9_]*$/.test(key),'Use a snake_case metric key.');
 check(metricKinds.includes(d.kind as never),'Unsupported aggregation. Counters, cohorts, formulas and scalar percentile merging require explicit specialized definitions.');
 check(['events','measurements','aggregates'].includes(String(d.inputMode)),'Choose an input mode.');
 check(!(d.inputMode==='aggregates'&&['distinct','p95'].includes(String(d.kind))),'Scalar distinct counts and percentiles cannot be merged. Send raw observations.');
 const dims=d.dimensions??[];check(Array.isArray(dims)&&dims.length<=8&&dims.every(x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(x))&&new Set(dims).size===dims.length,'Declare up to eight unique dimensions.');
 const timezone=String(d.timezone||'UTC');try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{check(false,'Unknown reporting timezone.');}
 const filters=object(d.filters??{});check(Object.keys(filters).length<=8&&Object.entries(filters).every(([k,v])=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&typeof v==='string'),'Filters must be a field-to-string map.');
 const freshnessSeconds=Number(d.freshnessSeconds??86400),maxSeries=Number(d.maxSeries??10000);check(Number.isInteger(freshnessSeconds)&&freshnessSeconds>=60&&freshnessSeconds<=31536000,'Invalid freshness interval.');check(Number.isInteger(maxSeries)&&maxSeries>=1&&maxSeries<=100000,'Invalid series budget.');
 const status=String(d.status||'draft');check(['draft','active','paused','retired'].includes(status),'Invalid lifecycle.');
 const field=(k:string,fallback:string)=>{const v=String(d[k]??fallback);check(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v),'Invalid input field.');return v;};
 const direction=String(d.direction||'neutral');check(['higher','lower','neutral'].includes(direction),'Invalid favorable direction.');
 const missingData=d.missingData??'leave_gaps';
 check(['leave_gaps','keep_previous'].includes(String(missingData)),'Choose Leave gaps or Keep previous value.');
 check(missingData!=='keep_previous'||d.kind==='latest','Keep previous value is available for latest snapshot metrics only.');
 const policy=storagePolicy(d.storagePolicy,d.kind as MetricDefinition['kind']);
 if(policy&&policy.baseResolution!=='day'){for(const date of ['2026-01-15','2026-07-15']){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date(date+'T00:00:00Z')).map(p=>[p.type,Number(p.value)]));check((parts.hour*3600+parts.minute*60)%resolutionSeconds[policy.baseResolution]===0,'Base intervals must align with reporting-day boundaries. Choose a finer base resolution for this timezone.');}}
 return {missingData:missingData as MetricDefinition['missingData'],storagePolicy:policy,key,name:text(d.name,'Name'),description:String(d.description??'').slice(0,4000),category:String(d.category||'operations'),kind:d.kind as MetricDefinition['kind'],unit:text(d.unit,'Unit',40),sourceId:text(d.sourceId,'Source'),datasetKey:String(d.datasetKey||key),inputMode:d.inputMode as MetricDefinition['inputMode'],valueField:field('valueField','value'),numeratorField:field('numeratorField','numerator'),denominatorField:field('denominatorField','denominator'),identityField:field('identityField','identity'),dimensions:dims as string[],filters:filters as Record<string,string>,timezone,freshnessSeconds,maxSeries,status:status as MetricDefinition['status'],direction:direction as MetricDefinition['direction']};
}
export function dimensionValues(value:unknown,names:string[]){const d=object(value??{});check(Object.keys(d).sort().join('|')===[...names].sort().join('|'),'Supply exactly the declared dimensions; totals and subtotals cannot overlap.');for(const [k,v]of Object.entries(d))text(v,k,200);check(new TextEncoder().encode(canonical(d)).length<=1536,'Dimension values exceed the series key budget.');return d as Record<string,string>;}
