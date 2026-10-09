import type { BaseResolution, QueryInterval } from '@/models/metrics/resolution';
export function bucketSql(time:string,level:QueryInterval,zone:string){
 if(['day','week','month'].includes(level))return `(date_trunc('${level}',(${time}) AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
 const width=({minute:'1 minute','5_minutes':'5 minutes','15_minutes':'15 minutes',hour:'1 hour'} as Record<string,string>)[level];
 if(!width)throw new Error('Unsupported resolution');
 return `date_bin(interval '${width}',${time},timestamptz '2000-01-01 00:00:00+00')`;
}
export function endSql(start:string,level:QueryInterval,zone:string){
 if(['day','week','month'].includes(level))return `(((${start}) AT TIME ZONE ${zone}+interval '1 ${level}') AT TIME ZONE ${zone})`;
 const width=({minute:'1 minute','5_minutes':'5 minutes','15_minutes':'15 minutes',hour:'1 hour'} as Record<string,string>)[level];
 if(!width)throw new Error('Unsupported resolution');
 return `(${start}+interval '${width}')`;
}
export function levels(base:BaseResolution):BaseResolution[]{return [...new Set([base,...(base==='day'?[]:['hour','day'] as BaseResolution[])])];}
