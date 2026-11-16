import type {FunnelStep} from '@/models/metrics/events';
export type FunnelQuery={sourceId:string;datasetKey:string;schemaVersion:number;startsAt:string;endsAt:string;unit:'person'|'account';windowSeconds:number;steps:FunnelStep[]};
// Parameterized exact, typed filters. No raw-payload join without property filters.
export function funnelCandidateSql(q:FunnelQuery,mapping:{properties?:string},actors?:string[]){
 const args:unknown[]=[q.sourceId,q.datasetKey,q.schemaVersion,q.startsAt,q.endsAt];
 const param=(v:unknown)=>{args.push(v);return '$'+args.length;};
 const hasProperties=q.steps.some(s=>Object.keys(s.properties??{}).length);
 const base=`r.payload->'original'->'record'->'data'`;
 const data=hasProperties&&mapping.properties?`(${base}->${param(mapping.properties)}::text)`:base;
 const actor=q.unit==='person'?'coalesce(identity.user_id,e.user_id)':'e.account_id';
 const selected=actors?param(actors):null;
 const actorFilter=selected?(q.unit==='account'?`AND e.account_id=ANY(${selected}::text[])`:`AND e.user_id=ANY(ARRAY(SELECT unnest(${selected}::text[]) UNION SELECT anonymous_id FROM metric_event_identities WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3 AND user_id=ANY(${selected}::text[])))`):'';
 const propertyNames=[...new Set(q.steps.filter(s=>Object.keys(s.properties??{}).length).map(s=>s.name))];
 const plainNames=[...new Set(q.steps.map(s=>s.name))].filter(n=>!propertyNames.includes(n));
 // Disjoint name branches keep payload lookups off events that have no property
 // predicates. A repeated name with mixed predicates stays in ONE branch.
 const branch=(names:string[],properties:boolean)=>{
  const mask=q.steps.map((s,i)=>!names.includes(s.name)?'0':`CASE WHEN e.name=${param(s.name)}::text${Object.entries(s.properties??{}).map(([k,v])=>` AND (${data}->${param(k)}::text)=${param(JSON.stringify(v))}::jsonb`).join('')} THEN ${1<<i} ELSE 0 END`).join(' + ');
  return `SELECT ${actor} AS actor,e.occurred_at,e.record_id,(${mask})::int AS mask FROM metric_event_index e
 ${properties?'JOIN metric_record_keys r ON (r.source_id,r.record_id,r.revision)=(e.source_id,e.record_id,e.revision)':''}
 ${q.unit==='person'?'LEFT JOIN metric_event_identities identity ON (identity.source_id,identity.dataset_key,identity.schema_version,identity.anonymous_id)=(e.source_id,e.dataset_key,e.schema_version,e.user_id)':''}
 WHERE e.source_id=$1 AND e.dataset_key=$2 AND e.schema_version=$3 AND e.occurred_at>=$4 AND e.occurred_at<$5 AND e.name=ANY(${param(names)}::text[]) ${actorFilter}`;
 };
 const branches=[...(plainNames.length?[branch(plainNames,false)]:[]),...(propertyNames.length?[branch(propertyNames,true)]:[])];
 return {args,sql:`SELECT actor,occurred_at,mask FROM (${branches.join(' UNION ALL ')}) candidates
 WHERE actor IS NOT NULL AND mask<>0 ${selected?`AND actor COLLATE "C"=ANY(${selected}::text[])`:""} ORDER BY actor COLLATE "C",occurred_at,record_id COLLATE "C"`};
}
