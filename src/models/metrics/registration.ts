import { metricMetadataFields } from './definition-contract';
import { check, definition, object } from './validation';
import type { MetricDefinition } from './types';

export function onlyFields(value:Record<string,unknown>, fields:readonly string[]) {
  const unexpected=Object.keys(value).filter(key=>!fields.includes(key));
  check(!unexpected.length,`Unsupported fields: ${unexpected.join(', ')}.`);
}
const definitionFields=[...metricMetadataFields,'key','kind','unit','inputMode','datasetKey','valueField','numeratorField','denominatorField','identityField','dimensions','filters','timezone','freshnessSeconds','missingData','storagePolicy'];
export function registration(input:unknown,sourceId:string) {
  const body=object(input);onlyFields(body,['definition','dataset']);
  const raw=object(body.definition);onlyFields(raw,definitionFields);
  if(raw.storagePolicy!=null)onlyFields(object(raw.storagePolicy),['baseResolution','baseRetentionDays','hourRetentionDays','dayRetentionDays','rawRetentionDays']);
  const config=definition({...raw,sourceId});config.dimensions.sort();
  check(!(config.inputMode==='aggregates'&&config.kind==='latest'),'Latest requires point observations; use measurements or events.');
  let dataset:{version:number;schema:Record<string,unknown>}|undefined;
  if(body.dataset!==undefined){
    check(config.inputMode==='events','A dataset schema is only valid for event metrics.');
    const d=object(body.dataset);onlyFields(d,['version','schema']);
    const version=d.version??1,schema=object(d.schema);
    check(Number.isSafeInteger(version)&&Number(version)>0&&Number(version)<=2147483647,'Dataset version must be a positive integer.');
    check(Object.keys(schema).length>0&&Object.keys(schema).length<=50&&Object.entries(schema).every(([key,type])=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)&&typeof type==='string'&&['string','decimal','datetime'].includes(type)),'Use 1–50 declared dataset fields with string, decimal or datetime types.');
    dataset={version:Number(version),schema};validateDataset(config,schema);
  }
  return {definition:config,...(dataset?{dataset}:{})};
}
export function validateDataset(config:MetricDefinition,schema:Record<string,unknown>) {
  const required:Record<string,string>={};
  for(const key of config.dimensions)required[key]='string';
  if(config.kind==='ratio'){required[config.numeratorField]='decimal';required[config.denominatorField]='decimal';}
  else if(config.kind==='distinct')required[config.identityField]='string';
  else if(config.kind!=='count')required[config.valueField]='decimal';
  for(const key of config.dimensions)check(schema[key]==='string',`Dataset dimension ${key} must be a string.`);
  for(const [key,type]of Object.entries(required))check(schema[key]===type,`Dataset field ${key} must be ${type}.`);
  for(const key of Object.keys(config.filters))check(key in schema,`Declare dataset filter field ${key}.`);
}
export function metricPatch(input:unknown) {
  const body=object(input);onlyFields(body,['expectedRevision','changes']);
  const changes=object(body.changes);
  check(Object.keys(changes).length>0,'Supply at least one metadata change.');
  const immutable=Object.keys(changes).filter(key=>!metricMetadataFields.includes(key as never));
  check(!immutable.length,`Metric contract is immutable. Only ${metricMetadataFields.join(', ')} can be edited.`,409);
  for(const [key,value]of Object.entries(changes))check(key==='maxSeries'?Number.isSafeInteger(value):typeof value==='string',`Invalid type for ${key}.`);
  expectedRevision(body.expectedRevision);
  return {expectedRevision:body.expectedRevision,changes};
}
export function expectedRevision(value:unknown):asserts value is number {
  check(Number.isSafeInteger(value)&&Number(value)>0,'Supply a positive integer expectedRevision.');
}
