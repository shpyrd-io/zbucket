import {canonical} from '@/models/metrics/validation';
import {decimalCompare,decimalSum} from '@/models/metrics/visualization';
import type pg from 'pg';
import type { Metric,MetricQuery,MetricResult,ObservationMetadata } from '@/models/metrics/types';
import { queryIntervals,resolutionSeconds,type BaseResolution } from '@/models/metrics/resolution';
import { check,instant,object } from '@/models/metrics/validation';
import { bucketSql,endSql,levels } from './resolution-sql';

// Called inside the same repeatable-read transaction as the public query.
export async function queryResolution(c:pg.PoolClient,m:Metric,q:MetricQuery):Promise<MetricResult>{
 const start=instant(q.startsAt),end=instant(q.endsAt),interval=q.interval??'day';
 check(end>start&&Date.parse(end)-Date.parse(start)<=732*86400000,'Choose a period of at most 732 days.');
 check(queryIntervals.includes(interval),'Unsupported query interval.');
 const dims=object(q.dimensions??{});check(Object.entries(dims).every(([k,v])=>m.dimensions.includes(k)&&typeof v==='string'&&v.length<=200),'Use declared dimension filters.');
 const group=q.groupBy??[];check(Array.isArray(group)&&group.length<=3&&new Set(group).size===group.length&&group.every(k=>m.dimensions.includes(k)),'Choose up to three declared dimensions.');
 const limit=q.groupLimit??50;check(Number.isInteger(limit)&&limit>0&&limit<=100,'Choose 1–100 groups.');check(!q.groupAfter||typeof q.groupAfter==='string'&&q.groupAfter.length<=3000,'Invalid group cursor.');
 check(!q.aggregation||m.kind==='latest'&&['sum','mean','min','max'].includes(q.aggregation),'Cross-series aggregation is available for snapshot metrics only. Other metrics use their defined reducer.');
 if(m.kind==='latest'&&m.dimensions.some(k=>!(k in dims)))check(q.aggregation,'Choose Sum, Average, Minimum or Maximum to combine snapshot series.');
 check(!q.groupMode||['auto','selected','top'].includes(q.groupMode),'Invalid group display mode.');
 check(!q.groupSearch||typeof q.groupSearch==='string'&&q.groupSearch.length<=200,'Invalid group search.');
 if(q.groupSelection)check(Array.isArray(q.groupSelection)&&q.groupSelection.length<=10&&q.groupSelection.every(d=>Object.keys(d).length===group.length&&Object.entries(d).every(([k,v])=>group.includes(k)&&typeof v==='string')),'Choose valid dimension groups.');
 const p=m.storagePolicy;
 const requestedSeconds=resolutionSeconds[interval as BaseResolution]??Infinity;
 if(p)check(requestedSeconds>=resolutionSeconds[p.baseResolution],'Requested interval is finer than the metric base resolution.');
 const params:unknown[]=[m.id,m.version,start,end,JSON.stringify(dims),m.timezone,m.freshnessSeconds,group];
 let level='raw';
 if(p){
  for(const l of levels(p.baseResolution).reverse()){
   if(resolutionSeconds[l]>requestedSeconds)continue;
   const days=l==='day'?p.dayRetentionDays:l==='hour'?p.hourRetentionDays:p.baseRetentionDays;
   const b=bucketSql('$3::timestamptz',l,'$6'),e=bucketSql('$4::timestamptz',l,'$6');
   const rawFloor=p.rawRetentionDays===null?"'-infinity'::timestamptz":bucketSql(`current_timestamp-(interval '1 day'*${p.rawRetentionDays})`,'day','$6');
   const availableRaw=`greatest(${rawFloor},coalesce((SELECT raw_before FROM metric_retention_watermarks WHERE metric_id=$1 AND version=$2),'-infinity'::timestamptz))`;
   const ok=await c.query(`SELECT ($3::timestamptz=${b} OR ${b}>=${availableRaw}) AND ($4::timestamptz=${e} OR ${e}>=${availableRaw}) AND $3::timestamptz>=${bucketSql("current_timestamp-($9::int*interval '1 day')",'day','$6')} AS ok WHERE $1::uuid IS NOT NULL AND $2::int>0 AND $5::jsonb IS NOT NULL AND $7::int>0 AND $6::text IS NOT NULL AND $8::text[] IS NOT NULL`,[...params,days]);
   if(ok.rows[0].ok){level=l;break;}
  }
  if(level==='raw'){
   // Raw may resolve recent partial boundaries, but cannot bypass resolution retention.
   const days=interval==='day'||interval==='week'||interval==='month'?p.dayRetentionDays:interval==='hour'?p.hourRetentionDays:p.baseRetentionDays;
   const ok=await c.query(`SELECT $1::timestamptz>=${bucketSql("current_timestamp-($2::int*interval '1 day')",'day','$3')} ok`,[start,days,m.timezone]);
   check(ok.rows[0].ok,'Requested resolution has expired. Choose a coarser interval or a more recent period.');
   if(p.rawRetentionDays!==null){const raw=await c.query(`SELECT $1::timestamptz>=${bucketSql("current_timestamp-($2::int*interval '1 day')",'day','$3')} ok`,[start,p.rawRetentionDays,m.timezone]);check(raw.rows[0].ok,'Align the period to retained aggregate boundaries; raw detail has expired.');}
  }
 }
 if(!p&&m.inputMode==='events'&&!['latest','distinct','p95'].includes(m.kind)&&requestedSeconds>=3600&&new Intl.DateTimeFormat('en',{timeZone:m.timezone,minute:'numeric'}).format(new Date(start))==='0')level='legacy_hour';
 const snapshot=m.kind==='latest',carry=snapshot&&m.missingData==='keep_previous';
 const predicate=`metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb AND ${level==='raw'?'observed_at':'bucket'}<$4::timestamptz AND ${level==='raw'?'observed_at':'bucket'}>=${snapshot?(carry&&!p?"'-infinity'::timestamptz":"$3::timestamptz-($7::int*interval '1 second')-interval '1 day'"):"$3::timestamptz"}`;
 const table=level==='raw'?'metric_facts':level==='legacy_hour'?'metric_aggregate_states':'metric_rollups';
 const retainedLevel=carry&&p&&level!=='raw'?` AND ends_at>${bucketSql(`current_timestamp-interval '1 day'*${level==='day'?p.dayRetentionDays:level==='hour'?p.hourRetentionDays:p.baseRetentionDays}`,'day','$6')}`:'';
 const filter=predicate+retainedLevel+' AND $3::timestamptz IS NOT NULL AND $7::int>0 AND $6::text IS NOT NULL'+(level==='raw'||level==='legacy_hour'?'':` AND level='${level}'`);
 const count=await c.query(`SELECT count(*) n FROM(SELECT 1 FROM ${table} WHERE ${filter} AND $6::text IS NOT NULL AND $8::text[] IS NOT NULL AND $7::int>0 LIMIT ${level==='raw'?100001:1000001}) t`,params);
 check(Number(count.rows[0].n)<=(level==='raw'?100000:1000000),'Query exceeds the detail budget. Use a shorter period, dimension filters or a coarser interval.');
 {
  const split=await c.query(`SELECT 1 FROM metric_facts WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb AND observed_at<$4::timestamptz AND ends_at>$3::timestamptz AND ends_at IS NOT NULL AND (observed_at<$3::timestamptz OR ends_at>$4::timestamptz OR ends_at>${endSql(bucketSql('observed_at',interval,'$6'),interval,'$6')}) AND $6::text IS NOT NULL AND $8::text[] IS NOT NULL AND $7::int>0 LIMIT 1`,params);
  check(!split.rowCount,'The query splits an indivisible source interval. Choose a compatible interval.');
 }
 const rawColumns="observed_at t,dimensions,v total,n,d,v min,v max,v last,observed_at last_at,source_id::text||':'||record_id last_key,1::bigint count,identity,received_at";
 let source=level==='raw'?`SELECT ${rawColumns} FROM metric_facts WHERE ${filter}`:`SELECT bucket t,dimensions,total,n,d,min,max,last,last_at,${level==='legacy_hour'?"''::text":'last_key'} last_key,count,NULL::text identity,${level==='legacy_hour'?'NULL::timestamptz':'received_at'} received_at FROM ${table} WHERE ${filter}`;
 if(level!=='raw'){
  const l=level==='legacy_hour'?'hour':level as BaseResolution;
  const low=bucketSql('$3::timestamptz',l,'$6'),high=bucketSql('$4::timestamptz',l,'$6'),fullStart=`CASE WHEN $3::timestamptz=${low} THEN $3::timestamptz ELSE ${endSql(low,l,'$6')} END`;
  const rawRange=`metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb AND observed_at>=${snapshot?low:'$3::timestamptz'} AND observed_at<$4::timestamptz AND (observed_at<${fullStart} OR observed_at>=${high})`;
  const edges=await c.query(`SELECT count(*) n FROM(SELECT 1 FROM metric_facts WHERE ${rawRange} AND $7::int>0 AND $8::text[] IS NOT NULL AND $6::text IS NOT NULL LIMIT 100001) x`,params);
  check(Number(edges.rows[0].n)<=100000,'Boundary detail exceeds the query budget. Align dates to retained intervals.');
  source+=` AND bucket<${high} ${snapshot?`AND NOT(bucket=${low} AND $3::timestamptz<>${low})`:`AND bucket>=${fullStart}`} UNION ALL SELECT ${rawColumns} FROM metric_facts WHERE ${rawRange}`;
 }
 if(level==='raw'){
  const expired=await c.query('SELECT 1 FROM metric_retention_watermarks WHERE metric_id=$1 AND version=$2 AND raw_before>$3',[m.id,m.version,start]);
  check(!expired.rowCount,'Raw detail has expired. Choose retained aggregate boundaries.');
 }

 const first=bucketSql('$3::timestamptz',interval,'$6');
 const next=endSql('t',interval,'$6');
 // Recursive calendar stepping handles DST without assuming every day is 24 hours.
 const timeline=`ticks(t) AS (SELECT ${first} UNION ALL SELECT ${next} FROM ticks WHERE ${next}<$4::timestamptz)`;
 const size=await c.query(`WITH RECURSIVE ${timeline} SELECT count(*) n FROM(SELECT t FROM ticks LIMIT 10002) x WHERE $1::uuid IS NOT NULL AND $2::int>0 AND $5::jsonb IS NOT NULL AND $7::int>0 AND $6::text IS NOT NULL AND $8::text[] IS NOT NULL`,params);
 check(Number(size.rows[0].n)<=10000,'Choose a coarser interval; a series can contain at most 10,000 points.');
 const population=`population AS (SELECT dimensions FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb)`;
 const pop=await c.query('SELECT count(*) n FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2 AND dimensions @> $3::jsonb',[m.id,m.version,JSON.stringify(dims)]);
 if(snapshot)check(Number(pop.rows[0].n)*(Number(size.rows[0].n)+1)<=100000,'Snapshot query exceeds the series × time budget. Filter dimensions or use a coarser interval.');
 // One indexed predecessor per retained level and tuple seeds the range. No synthetic facts.
 // Finer expired states cannot be revived; daily retained state can still seed a recent hourly report.
 if(carry&&p){
  const candidates=levels(p.baseResolution).map(l=>{
   const days=l==='day'?p.dayRetentionDays:l==='hour'?p.hourRetentionDays:p.baseRetentionDays;
   const floor=bucketSql(`current_timestamp-interval '1 day'*${days}`,'day','$6');
   return `(SELECT bucket t,dimensions,total,n,d,min,max,last,last_at,last_key,count,NULL::text identity,received_at
    FROM metric_rollups WHERE metric_id=$1 AND version=$2 AND level='${l}' AND dimensions=p.dimensions
    AND bucket<$3::timestamptz AND last_at<$3::timestamptz AND ends_at>${floor}
    ORDER BY bucket DESC LIMIT 1)`;
  });
  source+=` UNION ALL SELECT seed.* FROM population p CROSS JOIN LATERAL
   (SELECT * FROM (${candidates.join(' UNION ALL ')}) candidates ORDER BY last_at DESC,last_key DESC LIMIT 1) seed`;
 }
 const key=`coalesce((SELECT jsonb_object_agg(k,dimensions->k) FROM unnest($8::text[]) k),'{}'::jsonb)`;
 const reducer=snapshot?({sum:'sum(last)',mean:'avg(last)',min:'min(last)',max:'max(last)'}[q.aggregation??'sum']):({sum:'sum(total)',count:'sum(total)',mean:'sum(n)/nullif(sum(d),0)',ratio:'sum(n)/nullif(sum(d),0)',min:'min(min)',max:'max(max)',distinct:'count(DISTINCT identity)',p95:'percentile_cont(0.95) WITHIN GROUP(ORDER BY total::double precision)',latest:'max(last)'}[m.kind]);
 const common=`WITH RECURSIVE ${timeline},${population},source AS MATERIALIZED (${source})`;
 let rows:string;
 if(snapshot){
  rows=`latest_samples AS (SELECT DISTINCT ON(dimensions,last_at) * FROM source ORDER BY dimensions,last_at,last_key DESC),
   lifetimes AS (SELECT *,lead(last_at) OVER(PARTITION BY dimensions ORDER BY last_at) next_at FROM latest_samples),
   points AS (SELECT t,least(${next},$4::timestamptz) at FROM ticks UNION ALL SELECT NULL::timestamptz,$4::timestamptz),
   selected AS (SELECT points.t,p.dimensions,s.last,s.last_at,s.n,s.d,s.received_at,CASE WHEN s.last_at>=points.at-($7::int*interval '1 second') THEN 1 ELSE 0 END valid
    FROM points CROSS JOIN population p LEFT JOIN lifetimes s ON s.dimensions=p.dimensions AND s.last_at<points.at AND (s.next_at IS NULL OR s.next_at>=points.at)),
   values_by_scope AS(SELECT *,${key} g FROM selected),
   results AS(SELECT t,CASE WHEN grouping(g)=1 THEN NULL ELSE g END g,
    CASE WHEN ${carry?'count(last)=count(*)':'min(valid)=1'} THEN ${reducer} END::text value,${carry?'count(last)':'sum(valid)'}::text count,NULL::text numerator,NULL::text denominator,
    CASE WHEN count(last)<count(*) THEN 'missing' WHEN min(valid)=1 THEN 'complete' ELSE 'stale' END quality,max(received_at) received_at,
    max(last_at) observed_at,min(last_at) oldest_observed_at,count(last) known_count,count(*) expected_count,
    count(*) FILTER(WHERE last IS NOT NULL AND valid=0) stale_count
    FROM values_by_scope GROUP BY GROUPING SETS((t,g),(t)))`;
 }else{
  rows=`values_by_scope AS(SELECT *,${bucketSql('t',interval,'$6')} point,${key} g FROM source),
   results AS(SELECT CASE WHEN grouping(point)=1 THEN NULL ELSE point END t,CASE WHEN grouping(g)=1 THEN NULL ELSE g END g,
   (${reducer})::text value,sum(count)::text count,sum(n)::text numerator,sum(d)::text denominator,'partial'::text quality,max(received_at) received_at
   FROM values_by_scope GROUP BY GROUPING SETS((point,g),(point),(g),()))`;
 }
 const resultRows=await c.query(`${common},${rows} SELECT * FROM results ORDER BY t NULLS FIRST,g NULLS FIRST LIMIT 100002`,params);
 check(resultRows.rows.length<=100000,'Grouped result exceeds the point budget. Filter dimensions or use a coarser interval.');
 const all=resultRows.rows,summary=all.find(r=>r.t===null&&r.g===null);
 const pending=await c.query(`SELECT 1 FROM metric_record_keys WHERE NOT processed AND payload->'projections' @> $1::jsonb UNION ALL SELECT 1 FROM metric_event_processing WHERE metric_id=$2 AND status<>'completed' LIMIT 1`,[JSON.stringify([{metricId:m.id,version:m.version}]),m.id]);
 const coverage=await c.query(`WITH required AS(SELECT dimensions FROM metric_dimension_sets WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb),covered AS(SELECT dimensions,range_agg(tstzrange(starts_at,ends_at,'[)')) ranges,max(ends_at) ends_at FROM metric_coverage WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb GROUP BY dimensions) SELECT count(*) required,count(*) FILTER(WHERE ranges @> tstzrange($3::timestamptz,$4::timestamptz,'[)')) complete,min(ends_at) ends_at FROM required LEFT JOIN covered USING(dimensions)`,params.slice(0,5));
 const covered=coverage.rows[0].required!=='0'&&coverage.rows[0].required===coverage.rows[0].complete;
 const metadata=(r:Record<string,unknown>|undefined):ObservationMetadata=>snapshot?{
  observedAt:r?.observed_at?new Date(String(r.observed_at)).toISOString():null,
  oldestObservedAt:r?.oldest_observed_at?new Date(String(r.oldest_observed_at)).toISOString():null,
  knownCount:Number(r?.known_count??0),expectedCount:Number(r?.expected_count??0),staleCount:Number(r?.stale_count??0),
 }:{};
 const quality=(r:Record<string,unknown>|undefined)=>pending.rowCount?'recomputing':!r||r.value===null?'missing':snapshot?String(r.quality):covered?'complete':'partial';
 const points=(g:unknown)=>{const matching=new Map(all.filter(r=>r.t!==null&&JSON.stringify(r.g)===JSON.stringify(g)).map(r=>[new Date(r.t).toISOString(),r]));return matching;};
 const ticks=(await c.query(`WITH RECURSIVE ${timeline} SELECT t FROM ticks WHERE $1::uuid IS NOT NULL AND $2::int>0 AND $5::jsonb IS NOT NULL AND $7::int>0 AND $6::text IS NOT NULL AND $8::text[] IS NOT NULL ORDER BY t`,params)).rows;
 const series=(g:unknown)=>{const lookup=points(g);return ticks.map(({t})=>{const startsAt=new Date(t).toISOString(),r=lookup.get(startsAt);return {...metadata(r),startsAt,value:r?.value??null,count:r?.count??'0',quality:quality(r)};});};
 const received=await c.query('SELECT max(received_at) t FROM metric_facts WHERE metric_id=$1 AND version=$2 AND observed_at<$3 AND dimensions @> $4::jsonb',[m.id,m.version,end,JSON.stringify(dims)]);
 const generation=(await c.query('SELECT txid_current_snapshot()::text generation')).rows[0].generation;
 const result:MetricResult={...metadata(summary),groupBy:group,metric:m,value:summary?.value??null,count:summary?.count??'0',numerator:summary?.numerator??null,denominator:summary?.denominator??null,startsAt:start,endsAt:end,interval,aggregation:q.aggregation??m.kind,resolution:level,quality:quality(summary),generation,lastReceivedAt:summary?.received_at||received.rows[0].t?new Date(summary?.received_at??received.rows[0].t).toISOString():null,coverageEndsAt:coverage.rows[0].ends_at?new Date(coverage.rows[0].ends_at).toISOString():null,series:series(null)};
 if(result.value===null)result.reason=snapshot?(carry?'One or more known series have no retained observation before this boundary.':'One or more known series lack a fresh observation at this boundary.'):'No eligible value or denominator is zero.';
 if(group.length){
  const ordered=all.filter(r=>r.t===null&&r.g!==null).sort((a,b)=>JSON.stringify(a.g).localeCompare(JSON.stringify(b.g)));
  const after=q.groupAfter?ordered.findIndex(r=>JSON.stringify(r.g)===q.groupAfter)+1:0;check(!q.groupAfter||after>0,'Invalid or expired group cursor.');
  result.groupCount=ordered.length;
  const matches=ordered.filter(r=>!q.groupSearch||Object.values(r.g).some(v=>String(v).toLowerCase().includes(q.groupSearch!.toLowerCase())));
  let page=q.groupMode==='selected'?ordered.filter(r=>q.groupSelection?.some(d=>canonical(d)===canonical(r.g))):q.groupMode==='top'?[...ordered].sort((a,b)=>a.value===null?1:b.value===null?-1:decimalCompare(b.value,a.value)).slice(0,Math.min(limit,10)):matches.slice(after,after+limit);
  result.groupChoices=matches.slice(0,50).map(r=>({dimensions:r.g,value:r.value}));
  const displayed=q.groupMode==='auto'&&ordered.length>=10?[]:page;
  result.breakdown={rows:page.map(r=>({...metadata(r),quality:quality(r),dimensions:r.g,value:r.value,count:r.count})),nextCursor:!['selected','top'].includes(q.groupMode??'')&&matches.length>after+limit?JSON.stringify(page.at(-1).g):undefined,order:'dimensions_asc'};
  result.groups=displayed.map(r=>({dimensions:r.g,series:series(r.g)}));
  result.groupDisplay=q.groupMode==='auto'&&ordered.length>=10?'all':'groups';
  result.groupComplete=page.length===ordered.length;
  if(q.groupMode==='selected'){result.groupComplete=page.length===(q.groupSelection?.length??0);}
  if((q.groupMode==='top'||q.groupRemainder===true)&&group.length===1&&(['sum','count'].includes(m.kind)||snapshot&&q.aggregation==='sum')&&ordered.length>page.length){
   const excluded=ordered.filter(r=>!page.includes(r));let label='Other (remaining groups)';while(ordered.some(r=>r.g[group[0]]===label))label+='*';const otherDims={[group[0]]:label};
   const otherValue=excluded.some(r=>r.value===null)?null:decimalSum(excluded.map(r=>r.value));
   const omitted=excluded.map(r=>series(r.g));const otherSeries=result.series.map((p,i)=>({startsAt:p.startsAt,quality:omitted.some(s=>s[i].value===null)?'missing':omitted.some(s=>s[i].quality==='stale')?'stale':p.quality,value:omitted.some(s=>s[i].value===null)?null:decimalSum(omitted.map(s=>s[i].value!)),count:decimalSum(omitted.map(s=>s[i].count))}));
   result.breakdown.rows.push({other:true,dimensions:otherDims,value:otherValue,count:decimalSum(excluded.map(r=>r.count))});result.groups.push({dimensions:otherDims,series:otherSeries});result.groupComplete=true;
  }
 }
 return result;
}
