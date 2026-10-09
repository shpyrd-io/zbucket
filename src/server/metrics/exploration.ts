import type pg from 'pg';
import { getMetric } from './service';
import { check,instant,object,text } from '@/models/metrics/validation';
import { queryMetric } from './query';

export async function metricData(pool:pg.Pool,id:string,cursor='',version?:number){
 const metric=await getMetric(pool,id,version);let after:{at:string;record:string;source:string}|undefined;
 if(cursor){check(cursor.length<1000,'Invalid data cursor.');try{const raw=object(JSON.parse(Buffer.from(cursor,'base64url').toString()));after={at:instant(raw.at),record:text(raw.record,'Record'),source:text(raw.source,'Source')};}catch{check(false,'Invalid data cursor.');}}
 const rows=(await pool.query(`SELECT source_id AS "sourceId",record_id AS "recordId",revision,observed_at AS "observedAt",ends_at AS "endsAt",v::text AS value,n::text AS numerator,d::text AS denominator,identity,dimensions,received_at AS "receivedAt",(SELECT r.payload->'original'->'record' FROM metric_record_keys r WHERE r.source_id=metric_facts.source_id AND r.record_id=metric_facts.record_id AND r.revision=metric_facts.revision) AS original FROM metric_facts WHERE metric_id=$1 AND version=$2 AND ($3::timestamptz IS NULL OR (observed_at,record_id,source_id::text)<($3::timestamptz,$4,$5)) ORDER BY observed_at DESC,record_id DESC,source_id DESC LIMIT 101`,[metric.id,metric.version,after?.at??null,after?.record??'',after?.source??''])).rows;
 const last=rows[99];return{rows:rows.slice(0,100),nextCursor:rows.length>100?Buffer.from(JSON.stringify({at:last.observedAt,record:last.recordId,source:last.sourceId})).toString('base64url'):undefined};
}
export async function sourceHealth(pool:pg.Pool){return (await pool.query(`SELECT s.id,s.name,s.active,s.created_at AS "createdAt",
 (SELECT max(created_at) FROM metric_ingestions i WHERE i.source_id=s.id) AS "lastReceivedAt",
 (SELECT min(created_at) FROM metric_ingestions i WHERE i.source_id=s.id AND i.status='accepted') AS "pendingSince",
 (SELECT count(*) FROM metric_ingestions i WHERE i.source_id=s.id AND i.status='accepted')::text AS "pendingBatches",
 (SELECT count(*) FROM metric_imports i WHERE i.source_id=s.id AND i.status='completed_with_errors')::text AS "importsWithErrors",
 '[]'::jsonb AS credentials,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('key',d.key,'version',d.version,'schema',d.schema)) FROM metric_datasets d WHERE d.source_id=s.id),'[]') AS datasets
 ,(SELECT count(*) FROM metrics m JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version WHERE v.config->>'sourceId'=s.id::text)::int AS "definitionCount",
 COALESCE((SELECT jsonb_agg(linked) FROM(SELECT m.id,m.key,v.config->>'name' AS name,v.version,(v.version=m.version) AS current FROM metrics m JOIN metric_definition_versions v ON v.metric_id=m.id AND v.version=m.version WHERE v.config->>'sourceId'=s.id::text ORDER BY m.key,v.version DESC LIMIT 20) linked),'[]') AS definitions
 FROM metric_sources s ORDER BY s.name,s.created_at,s.id LIMIT 200`)).rows;}
export async function goalResult(pool:pg.Pool,id:string,now=new Date()){
 const row=(await pool.query('SELECT * FROM metric_goals WHERE id=$1',[id])).rows[0];check(row,'Goal not found.',404);const cfg=row.config;
 if(Date.parse(cfg.startsAt)>=now.getTime())return{id,phase:'upcoming',value:null,attainment:null,gap:null,quality:'missing'};
 const end=new Date(Math.min(Date.parse(cfg.endsAt),now.getTime())).toISOString();const result=await queryMetric(pool,{metricId:row.metric_id,version:row.version,startsAt:cfg.startsAt,endsAt:end,dimensions:cfg.dimensions});
 const amounts=(await pool.query('SELECT ($1::numeric-$2::numeric)::text gap,CASE WHEN $2::numeric>0 THEN ($1::numeric/$2::numeric*100)::text END attainment',[result.value,cfg.target])).rows[0];
 return{id,unit:result.metric.unit,definitionVersion:result.metric.version,phase:Date.parse(cfg.endsAt)<=now.getTime()?'ended':'in_progress',value:result.value,quality:result.quality,...amounts,startsAt:result.startsAt,endsAt:result.endsAt,reason:Date.parse(cfg.endsAt)>now.getTime()?'Progress against final target; no expected trajectory has been assumed.':result.quality!=='complete'?'Final-period coverage is incomplete.':undefined};
}
