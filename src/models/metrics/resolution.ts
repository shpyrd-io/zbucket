import { DomainError } from '../policy';
import type { MetricKind } from './types';
export const baseResolutions = ['minute','5_minutes','15_minutes','hour','day'] as const;
export type BaseResolution = typeof baseResolutions[number];
export const queryIntervals = [...baseResolutions,'week','month'] as const;
export type QueryInterval = typeof queryIntervals[number];
export type StoragePolicy = {baseResolution:BaseResolution;baseRetentionDays:number;hourRetentionDays:number;dayRetentionDays:number;rawRetentionDays:number|null};
export const resolutionSeconds:Record<BaseResolution,number>={minute:60,'5_minutes':300,'15_minutes':900,hour:3600,day:86400};
export function storagePolicy(input:unknown,kind:MetricKind):StoragePolicy|undefined {
 if(input===undefined||input===null)return undefined;
 const fail=(message:string):never=>{throw new DomainError(422,message);};
 if(typeof input!=='object'||Array.isArray(input))fail('Invalid storage policy.');
 const r=input as Record<string,unknown>;
 const baseResolution=r.baseResolution as BaseResolution;
 if(!baseResolutions.includes(baseResolution))fail('Choose a supported base resolution.');
 if(['distinct','p95'].includes(kind))fail('Exact distinct and p95 require raw detail; resolution policies are not supported for these kinds.');
 const days=(key:string)=>{const n=Number(r[key]);if(!Number.isInteger(n)||n<1||n>36500)fail(`${key} must be between 1 and 36500 days.`);return n;};
 const baseRetentionDays=days('baseRetentionDays'),hourRetentionDays=days('hourRetentionDays'),dayRetentionDays=days('dayRetentionDays');
 if(baseRetentionDays>hourRetentionDays||hourRetentionDays>dayRetentionDays)fail('Retention must increase from base to hour to day.');
 if(baseResolution==='hour'&&baseRetentionDays!==hourRetentionDays||baseResolution==='day'&&(baseRetentionDays!==dayRetentionDays||hourRetentionDays!==dayRetentionDays))fail('When base is hour or day, duplicate resolution retentions must agree.');
 const rawRetentionDays=r.rawRetentionDays===null||r.rawRetentionDays===undefined?null:days('rawRetentionDays');
 if(rawRetentionDays!==null&&rawRetentionDays>baseRetentionDays)fail('Raw retention cannot exceed base retention.');
 return {baseResolution,baseRetentionDays,hourRetentionDays,dayRetentionDays,rawRetentionDays};
}
export function estimateStates(policy:StoragePolicy,series:number){
 const perDay=86400/resolutionSeconds[policy.baseResolution];
 const base=series*perDay*policy.baseRetentionDays;
 const hourly=policy.baseResolution==='day'||policy.baseResolution==='hour'?0:series*24*policy.hourRetentionDays;
 const daily=policy.baseResolution==='day'?0:series*policy.dayRetentionDays;
 return {base,hourly,daily,total:base+hourly+daily};
}
