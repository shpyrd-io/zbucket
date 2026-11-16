import { queryResolution } from './resolution-query';
import { observationMetadata } from '@/models/metrics/observations';
import type pg from 'pg';
import { v7 as uuid } from 'uuid';
import { check, instant } from '@/models/metrics/validation';
import type { Metric, MetricQuery, MetricResult } from '@/models/metrics/types';
import { getMetric } from './service';
function valueSql(m:Metric,state:boolean){switch(m.kind){case'sum':case'count':return state?'sum(total)':'sum(v)';case'mean':case'ratio':return'sum(n)/nullif(sum(d),0)';case'latest':return state?'(array_agg(last ORDER BY last_at DESC,dimensions::text))[1]':'(array_agg(v ORDER BY observed_at DESC,record_id DESC))[1]';case'min':return state?'min(min)':'min(v)';case'max':return state?'max(max)':'max(v)';case'distinct':return'count(DISTINCT identity)';case'p95':return'percentile_cont(0.95) WITHIN GROUP(ORDER BY v::double precision)';}}
export async function queryMetric(pool:pg.Pool,q:MetricQuery,actor?:string):Promise<MetricResult>{
 const definition=await getMetric(pool,q.metricId,q.version);
 if(definition.storagePolicy||q.interval||q.aggregation||definition.missingData==='keep_previous'){
 const connection=await pool.connect();try{await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const m=await getMetric(connection,q.metricId,q.version);const result=await queryResolution(connection,m,q);
 if(q.compareStartsAt&&q.compareEndsAt){const previous=await queryResolution(connection,m,{...q,startsAt:q.compareStartsAt,endsAt:q.compareEndsAt,groupAfter:undefined,...(q.groupMode==='top'?{groupMode:'selected' as const,groupSelection:result.groups?.slice(0,q.groupLimit??50).map(g=>g.dimensions),groupRemainder:true}:{})});const diff=(await connection.query('SELECT ($1::numeric-$2::numeric)::text absolute,CASE WHEN $2::numeric>0 THEN (($1::numeric-$2::numeric)/$2::numeric*100)::text END relative',[result.value,previous.value])).rows[0];result.comparison={...observationMetadata(previous),value:previous.value,quality:previous.quality,startsAt:previous.startsAt,endsAt:previous.endsAt,series:previous.series,groups:previous.groups,breakdown:previous.breakdown,...diff};}
 if(q.snapshot){const id=uuid();await connection.query('INSERT INTO metric_query_snapshots(id,metric_id,query,result,author_id) VALUES($1,$2,$3,$4,$5)',[id,m.id,q,result,actor??null]);result.snapshotId=id;}await connection.query('COMMIT');return result;
 }catch(e){await connection.query('ROLLBACK');throw e;}finally{connection.release();}}
const c=await pool.connect();let released=false;try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const m=await getMetric(c,q.metricId,q.version);const start=instant(q.startsAt),end=instant(q.endsAt);check(end>start,'End must follow start.');check(Date.parse(end)-Date.parse(start)<=732*86400000,'Interactive queries are limited to 732 days.');const dims=q.dimensions??{};check(Object.keys(dims).every(k=>m.dimensions.includes(k)),'Unknown breakdown filter.');
 if(m.kind==='latest')check(Object.keys(dims).length===m.dimensions.length,'Select a complete dimension scope for a snapshot metric.');
 const times=[m.id,m.version,start,end,JSON.stringify(dims)];
 const pending=await c.query(`SELECT 1 FROM metric_record_keys WHERE NOT processed AND payload->'projections' @> $1::jsonb UNION ALL SELECT 1 FROM metric_event_processing WHERE metric_id=$2 AND status<>'completed' LIMIT 1`,[JSON.stringify([{metricId:m.id,version:m.version}]),m.id]);
 const intervals=m.inputMode==='aggregates'||m.inputMode==='measurements';
 const hourAligned=[start,end].every(s=>Date.parse(s)%3600000===0);
 const zoneHourAligned=new Intl.DateTimeFormat('en',{timeZone:m.timezone,minute:'numeric'}).format(new Date(start))===new Intl.DateTimeFormat('en',{timeZone:'UTC',minute:'numeric'}).format(new Date(start));
 const fast=!['distinct','p95','latest'].includes(m.kind)&&!intervals&&zoneHourAligned;
 let table=fast?'metric_aggregate_states':'metric_facts';const time=fast?'bucket':'observed_at';
 if(fast&&!hourAligned){
  const edgeFilter="metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb AND observed_at >= $3::timestamptz AND observed_at < $4::timestamptz AND (observed_at < date_trunc('hour',$3::timestamptz)+interval '1 hour' OR observed_at >= date_trunc('hour',$4::timestamptz))";
  const edgeCount=await c.query(`SELECT count(*) n FROM (SELECT 1 FROM metric_facts WHERE ${edgeFilter} LIMIT 100001) x`,times);check(Number(edgeCount.rows[0].n)<=100000,'Boundary detail exceeds the query budget. Use aligned hours.');
  table=`(SELECT metric_id,version,bucket,dimensions,total,weight,n,d,min,max,last,last_at,count FROM metric_aggregate_states WHERE bucket >= CASE WHEN $3::timestamptz=date_trunc('hour',$3::timestamptz) THEN $3::timestamptz ELSE date_trunc('hour',$3::timestamptz)+interval '1 hour' END AND bucket < date_trunc('hour',$4::timestamptz)
  UNION ALL SELECT metric_id,version,greatest(date_trunc('hour',observed_at),$3::timestamptz) bucket,dimensions,COALESCE(sum(v),0),sum(weight),sum(n),sum(d),min(v),max(v),(array_agg(v ORDER BY observed_at DESC,record_id DESC))[1],max(observed_at),count(*) FROM metric_facts WHERE ${edgeFilter} AND NOT(observed_at>=CASE WHEN $3::timestamptz=date_trunc('hour',$3::timestamptz) THEN $3::timestamptz ELSE date_trunc('hour',$3::timestamptz)+interval '1 hour' END AND observed_at<date_trunc('hour',$4::timestamptz)) GROUP BY metric_id,version,greatest(date_trunc('hour',observed_at),$3::timestamptz),dimensions) combined`;
 }

 let where=`metric_id=$1 AND version=$2 AND ${time}>=$3::timestamptz AND ${time}<$4::timestamptz AND dimensions @> $5::jsonb`;
 if(m.kind==='latest')where=`metric_id=$1 AND version=$2 AND observed_at<$4::timestamptz AND dimensions @> $5::jsonb AND $3::timestamptz IS NOT NULL`;
 if(!fast){const bound=await c.query(`SELECT count(*) n FROM (SELECT 1 FROM metric_facts WHERE ${where} LIMIT 100001) x`,times);check(Number(bound.rows[0].n)<=100000,'Query exceeds the raw detail budget. Use aligned hourly boundaries or a smaller period.',422);
 const overlap=await c.query(`SELECT 1 FROM metric_facts WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb AND ends_at IS NOT NULL AND observed_at<$4::timestamptz AND ends_at>$3::timestamptz AND (observed_at<$3::timestamptz OR ends_at>$4::timestamptz) LIMIT 1`,times);check(!overlap.rowCount,'The requested period splits an indivisible source aggregate. Choose its complete interval.');}
 const sql=valueSql(m,fast);
 const total=await c.query(`SELECT (${sql})::text value,${fast?'COALESCE(sum(count),0)':'count(*)'}::text count,sum(n)::text numerator,sum(d)::text denominator FROM ${table} WHERE ${where}`,times);
 const series=await c.query(`SELECT (date_trunc('day',${time} AT TIME ZONE $6) AT TIME ZONE $6) AS "startsAt",(${sql})::text value,${fast?'sum(count)':'count(*)'}::text count FROM ${table} WHERE ${where} GROUP BY 1 ORDER BY 1 LIMIT 733`,[...times,m.timezone]);
 const meta=await c.query(`SELECT (SELECT received_at FROM metric_facts WHERE metric_id=$1 AND version=$2 AND observed_at<$4::timestamptz AND dimensions @> $5::jsonb ORDER BY received_at DESC LIMIT 1) received_at,(SELECT observed_at FROM metric_facts WHERE metric_id=$1 AND version=$2 AND observed_at<$4::timestamptz AND dimensions @> $5::jsonb ORDER BY observed_at DESC LIMIT 1) observed_at WHERE $3::timestamptz IS NOT NULL`,times);
 const cov=await c.query(`WITH required AS (SELECT dimensions FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb),covered AS (SELECT dimensions,range_agg(tstzrange(starts_at,ends_at,'[)')) ranges,max(ends_at) ends_at FROM metric_coverage WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb GROUP BY dimensions) SELECT count(*) required,count(*) FILTER(WHERE ranges @> tstzrange($3::timestamptz,$4::timestamptz,'[)')) complete,min(ends_at) ends_at FROM required LEFT JOIN covered USING(dimensions)`,times);
 const last=meta.rows[0].received_at?new Date(meta.rows[0].received_at).toISOString():null;const row=total.rows[0];if(row.count==='0')row.value=null;
 let quality=row.value===null?'missing':cov.rows[0].required!=='0'&&cov.rows[0].required===cov.rows[0].complete?'complete':'partial';
 if(m.kind==='latest'&&meta.rows[0].observed_at&&Date.parse(end)-new Date(meta.rows[0].observed_at).getTime()>m.freshnessSeconds*1000)quality='stale';
 if(pending.rowCount)quality='recomputing';
 const generation=(await c.query('SELECT txid_current_snapshot()::text generation')).rows[0].generation;
 const result:MetricResult={metric:m,...row,startsAt:start,endsAt:end,quality,generation,lastReceivedAt:last,coverageEndsAt:cov.rows[0].ends_at?new Date(cov.rows[0].ends_at).toISOString():null,series:series.rows.map(r=>({...r,startsAt:new Date(r.startsAt).toISOString()}))};
 if(q.groupBy){
  check(Array.isArray(q.groupBy)&&q.groupBy.length>0&&q.groupBy.length<=3&&new Set(q.groupBy).size===q.groupBy.length&&q.groupBy.every(k=>m.dimensions.includes(k)),'Choose up to three declared breakdown dimensions.');
  const limit=q.groupLimit??50;check(Number.isInteger(limit)&&limit>=1&&limit<=100,'Breakdown page size must be between 1 and 100.');
  check(!q.groupAfter||(typeof q.groupAfter==='string'&&q.groupAfter.length<=3000),'Invalid breakdown cursor.');
  // Dimension keys are bound parameters, never SQL identifiers supplied by callers.
  const keys=q.groupBy.map((_,i)=>`$${i+6}::text`);
  const dimensionSql=`jsonb_build_object(${keys.map(k=>`${k},dimensions->>${k}`).join(',')})`;
  const afterIndex=6+keys.length,limitIndex=afterIndex+1;
  const groups=await c.query(`SELECT * FROM (SELECT ${dimensionSql} dimensions,(${sql})::text value,${fast?'sum(count)':'count(*)'}::text count FROM ${table} WHERE ${where} GROUP BY ${dimensionSql}) groups WHERE dimensions::text > $${afterIndex} ORDER BY dimensions::text LIMIT $${limitIndex}`, [...times,...q.groupBy,q.groupAfter??'',limit+1]);
  const rows=groups.rows.slice(0,limit);const cursor=rows.length?(await c.query('SELECT $1::jsonb::text cursor',[JSON.stringify(rows.at(-1).dimensions)])).rows[0].cursor:undefined;
  result.breakdown={rows,nextCursor:groups.rows.length>limit?cursor:undefined,order:'dimensions_asc'};
 }
 if(row.value===null)result.reason=row.count==='0'?'No measurements in this period.':'The denominator is zero.';
 await c.query('COMMIT');c.release();released=true;
 if(q.compareStartsAt&&q.compareEndsAt){const previous=await queryMetric(pool,{...q,startsAt:q.compareStartsAt,endsAt:q.compareEndsAt,compareStartsAt:undefined,compareEndsAt:undefined,snapshot:false});const diff=await pool.query('SELECT ($1::numeric-$2::numeric)::text absolute,CASE WHEN $2::numeric>0 THEN (($1::numeric-$2::numeric)/$2::numeric*100)::text END relative',[result.value,previous.value]);result.comparison={...observationMetadata(previous),value:previous.value,quality:previous.quality,startsAt:previous.startsAt,endsAt:previous.endsAt,series:previous.series,groups:previous.groups,breakdown:previous.breakdown,...diff.rows[0]};}
 if(q.snapshot){const id=uuid();await pool.query('INSERT INTO metric_query_snapshots(id,metric_id,query,result,author_id) VALUES($1,$2,$3,$4,$5)',[id,m.id,q,result,actor??null]);result.snapshotId=id;}return result;
 }catch(e){if(!released)await c.query('ROLLBACK');throw e;}finally{if(!released)c.release();}}
