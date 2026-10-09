import {createHash} from 'node:crypto';
import {v7 as uuid} from 'uuid';
import type pg from 'pg';
import {DomainError} from '@/models/policy';
import {canonical, check, object, text} from '@/models/metrics/validation';
import {purgeScope, type PurgePreview, type PurgeResult, type PurgeScope} from '@/models/metrics/purge';
import type {Metric} from '@/models/metrics/types';
import {transaction} from '@/server/db/metrics';
import {admin, audit, type Principal} from '@/server/access';
import {getMetric} from './service';

// All predicates use start-inclusive/end-exclusive observation time. Interval
// contributions cannot be split; retained parent buckets need complete raw detail.
async function prepare(c: pg.PoolClient, m: Metric, scope: PurgeScope): Promise<PurgePreview> {
  const args = [m.id, m.version, scope.startsAt, scope.endsAt, JSON.stringify(scope.dimensions)];
  await c.query(`CREATE TEMP TABLE purge_facts ON COMMIT DROP AS
    SELECT * FROM metric_facts WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb
    AND ($3::timestamptz IS NULL OR (observed_at>=$3 AND observed_at<$4::timestamptz))`, args);
  await c.query(`CREATE TEMP TABLE purge_records ON COMMIT DROP AS
    SELECT source_id,record_id FROM purge_facts
    UNION SELECT r.source_id,r.record_id FROM metric_record_keys r
    CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p
    WHERE r.source_id=$6 AND p->>'metricId'=$1::text AND (p->>'version')::int=$2
    AND coalesce(p->'dimensions','{}'::jsonb) @> $5::jsonb
    AND ($3::timestamptz IS NULL OR ((p->>'observedAt')::timestamptz >=$3 AND (p->>'observedAt')::timestamptz<$4::timestamptz))
    AND NOT EXISTS(SELECT 1 FROM metric_record_keys newer WHERE newer.source_id=r.source_id AND newer.record_id=r.record_id AND newer.revision>r.revision)`, [...args, m.sourceId]);
  await c.query('CREATE UNIQUE INDEX ON purge_records(source_id,record_id)');
  const correcting = await c.query(`SELECT 1 FROM metric_record_keys r JOIN purge_records t USING(source_id,record_id)
    WHERE NOT r.processed AND r.revision>1 LIMIT 1`);
  check(!correcting.rowCount, 'A correction for selected records is still pending. Wait for ingestion to finish and preview again.', 409);
  if (scope.startsAt) {
    const split = await c.query(`SELECT 1 FROM metric_facts WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb
      AND ends_at IS NOT NULL AND observed_at<$4::timestamptz AND ends_at>$3::timestamptz AND (observed_at<$3 OR ends_at>$4)
      UNION ALL SELECT 1 FROM metric_record_keys r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p
      WHERE r.source_id=$6 AND p->>'metricId'=$1::text AND (p->>'version')::int=$2 AND p->'dimensions' @> $5::jsonb
      AND (p->>'observedAt')::timestamptz<$4::timestamptz AND (p->>'endsAt')::timestamptz>$3::timestamptz
      AND ((p->>'observedAt')::timestamptz<$3 OR (p->>'endsAt')::timestamptz>$4)
      AND NOT EXISTS(SELECT 1 FROM metric_record_keys newer WHERE newer.source_id=r.source_id AND newer.record_id=r.record_id AND newer.revision>r.revision)
      LIMIT 1`, [...args, m.sourceId]);
    check(!split.rowCount, 'This period cuts through a source aggregate. Include the entire source interval.');
  }
  await c.query(`CREATE TEMP TABLE purge_rollups ON COMMIT DROP AS SELECT *,
    ($3::timestamptz IS NOT NULL AND (bucket<$3 OR ends_at>$4::timestamptz)) AS rebuild
    FROM metric_rollups WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb
    AND ($3::timestamptz IS NULL OR (bucket<$4::timestamptz AND ends_at>$3))`, args);
  await c.query('CREATE INDEX ON purge_rollups(bucket,dimensions)');
  await c.query(`CREATE TEMP TABLE purge_states ON COMMIT DROP AS SELECT *,
    ($3::timestamptz IS NOT NULL AND (bucket<$3 OR bucket+interval '1 hour'>$4::timestamptz)) AS rebuild
    FROM metric_aggregate_states WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb
    AND ($3::timestamptz IS NULL OR (bucket<$4::timestamptz AND bucket+interval '1 hour'>$3))`, args);
  const unsafe = await c.query(`SELECT 1 FROM (
    SELECT bucket FROM purge_rollups WHERE rebuild UNION ALL SELECT bucket FROM purge_states WHERE rebuild
    ) b JOIN metric_retention_watermarks w ON w.metric_id=$1 AND w.version=$2 WHERE b.bucket<w.raw_before LIMIT 1`, [m.id,m.version]);
  check(!unsafe.rowCount, 'Raw detail has expired for a partially selected aggregate bucket. Choose whole reporting days, or remove this dimension across all time.');
  await c.query(`CREATE TEMP TABLE purge_coverage ON COMMIT DROP AS SELECT * FROM metric_coverage
    WHERE metric_id=$1 AND version=$2 AND dimensions @> $5::jsonb
    AND ($3::timestamptz IS NULL OR (starts_at<$4::timestamptz AND ends_at>$3))`, args);
  await c.query(`CREATE TEMP TABLE purge_dimensions ON COMMIT DROP AS
    SELECT dimensions FROM purge_facts UNION SELECT dimensions FROM purge_rollups UNION SELECT dimensions FROM purge_states
    UNION SELECT dimensions FROM purge_coverage
    UNION SELECT p->'dimensions' FROM metric_record_keys r JOIN purge_records t USING(source_id,record_id)
      CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p
      WHERE p->>'metricId'=$1::text AND (p->>'version')::int=$2 AND p ? 'dimensions'
    UNION SELECT dimensions FROM metric_dimension_sets WHERE metric_id=$1::uuid AND version=$2 AND dimensions @> $3::jsonb AND $4::timestamptz IS NULL`, [m.id,m.version,JSON.stringify(scope.dimensions),scope.startsAt]);
  const fingerprints: Record<string, {count:string; signature:string}> = {};
  for (const name of ['purge_facts','purge_rollups','purge_states','purge_coverage','purge_dimensions']) {
    fingerprints[name] = (await c.query(`SELECT count(*)::text count,coalesce(sum(hashtextextended(row_to_json(t)::text,0)::numeric),0)::text signature FROM ${name} t`)).rows[0];
  }
  fingerprints.records = (await c.query(`SELECT count(*)::text count,coalesce(sum(hashtextextended(row_to_json(r)::text,0)::numeric),0)::text signature
    FROM metric_record_keys r JOIN purge_records t USING(source_id,record_id)`)).rows[0];
  const counts = (await c.query(`SELECT (SELECT count(*)::int FROM purge_records) records,
    (SELECT count(*)::int FROM metric_record_keys r JOIN purge_records t USING(source_id,record_id) WHERE NOT processed) pending`)).rows[0];
  const watermark = (await c.query('SELECT raw_before FROM metric_retention_watermarks WHERE metric_id=$1 AND version=$2',[m.id,m.version])).rows[0]?.raw_before;
  return {
    metricId:m.id, metricKey:m.key, timezone:m.timezone, scope,
    fingerprint:createHash('sha256').update(canonical({id:m.id,version:m.version,scope,fingerprints,watermark:watermark?.toISOString()??null})).digest('hex'),
    counts:{measurements:Number(fingerprints.purge_facts.count),records:counts.records,pendingRecords:counts.pending,
      aggregateBuckets:Number(fingerprints.purge_rollups.count)+Number(fingerprints.purge_states.count),
      coverageIntervals:Number(fingerprints.purge_coverage.count),dimensionCombinations:Number(fingerprints.purge_dimensions.count)},
  };
}

async function scopedTransaction<T>(pool: pg.Pool, id: string, run:(c:pg.PoolClient,m:Metric)=>Promise<T>):Promise<T> {
  try {return await transaction(pool, async c => {
    await c.query("SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s'");
    const m = await getMetric(c,id);
    // Ingestion/retention take the source advisory lock. Publication takes the
    // source row before metric locks. Acquire both in that order to exclude each.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[m.sourceId]);
    await c.query('SELECT id FROM metric_sources WHERE id=$1 FOR UPDATE',[m.sourceId]);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric:${m.id}`]);
    return run(c,m);
  });} catch(e) {
    const code=(e as {code?:string}).code;
    if(code==='55P03')throw new DomainError(409,'This metric is busy. Retry the preview shortly.');
    if(code==='57014')throw new DomainError(422,'Cleanup exceeded its execution limit. Use a smaller period or a more specific dimension filter. No changes were committed.');
    throw e;
  }
}
export async function previewPurge(pool:pg.Pool, principal:Principal, id:string, input:unknown) {
  admin(principal);
  return scopedTransaction(pool,id,(c,m)=>prepare(c,m,purgeScope(input,m.dimensions)));
}
export async function purgeMetric(pool:pg.Pool, principal:Principal, id:string, input:unknown):Promise<PurgeResult> {
  const actor=admin(principal), b=object(input), reason=text(b.reason,'Reason',1000);
  return scopedTransaction(pool,id,async(c,m)=>{
    check(b.confirmationKey===m.key,'Type the exact metric key to confirm deletion.');
    const preview=await prepare(c,m,purgeScope(b,m.dimensions));
    check(b.fingerprint===preview.fingerprint,'Data changed since the preview. Review a new preview before purging.',409);
    check(Object.values(preview.counts).some(n=>n>0),'No matching retained data to purge.');
    const purgeId=uuid(), s=preview.scope;
    await c.query('INSERT INTO metric_purges(id,metric_id,actor_id,scope,counts,reason) VALUES($1,$2,$3,$4,$5,$6)',[purgeId,m.id,actor.id,s,preview.counts,reason]);
    await c.query(`INSERT INTO metric_purged_records(source_id,record_id,metric_id,version,purge_id)
      SELECT source_id,record_id,$1,$2,$3 FROM purge_records ON CONFLICT DO NOTHING`,[m.id,m.version,purgeId]);
    await c.query(`DELETE FROM metric_facts f USING purge_facts t WHERE
      (f.source_id,f.record_id,f.revision,f.metric_id,f.version,f.observed_at)=(t.source_id,t.record_id,t.revision,t.metric_id,t.version,t.observed_at)`);
    // Remove this metric from every revision of selected identities. Other
    // projections remain intact, including pending event fanout to other metrics.
    await c.query(`WITH stripped AS (
      SELECT r.source_id,r.record_id,r.revision,r.payload,
        coalesce((SELECT jsonb_agg(p) FROM jsonb_array_elements(r.payload->'projections') p
          WHERE NOT(p->>'metricId'=$1::text AND (p->>'version')::int=$2)),'[]'::jsonb) projections
      FROM metric_record_keys r JOIN purge_records t USING(source_id,record_id)
    ) UPDATE metric_record_keys r SET payload=CASE WHEN jsonb_array_length(s.projections)=0
      THEN (s.payload-'original')||jsonb_build_object('projections',s.projections,'purged',true)
      ELSE jsonb_set(s.payload,'{projections}',s.projections) END
      FROM stripped s WHERE (r.source_id,r.record_id,r.revision)=(s.source_id,s.record_id,s.revision)`,[m.id,m.version]);
    await c.query(`DELETE FROM metric_rollups r USING purge_rollups t WHERE
      (r.metric_id,r.version,r.level,r.bucket,r.dimensions)=(t.metric_id,t.version,t.level,t.bucket,t.dimensions);
      INSERT INTO metric_rollups SELECT t.metric_id,t.version,t.level,t.bucket,t.ends_at,t.dimensions,
        coalesce(sum(f.v),0),sum(f.n),sum(f.d),min(f.v),max(f.v),
        (array_agg(f.v ORDER BY f.observed_at DESC,f.source_id DESC,f.record_id DESC))[1],max(f.observed_at),
        (array_agg(f.source_id::text||':'||f.record_id ORDER BY f.observed_at DESC,f.source_id DESC,f.record_id DESC))[1],count(*),max(f.received_at)
      FROM purge_rollups t JOIN metric_facts f ON f.metric_id=t.metric_id AND f.version=t.version AND f.dimensions=t.dimensions
        AND f.observed_at>=t.bucket AND f.observed_at<t.ends_at WHERE t.rebuild
      GROUP BY t.metric_id,t.version,t.level,t.bucket,t.ends_at,t.dimensions;
      DELETE FROM metric_aggregate_states r USING purge_states t WHERE
        (r.metric_id,r.version,r.bucket,r.dimensions)=(t.metric_id,t.version,t.bucket,t.dimensions);
      INSERT INTO metric_aggregate_states SELECT t.metric_id,t.version,t.bucket,t.dimensions,
        coalesce(sum(f.v),0),sum(f.weight),sum(f.n),sum(f.d),min(f.v),max(f.v),
        (array_agg(f.v ORDER BY f.observed_at DESC,f.record_id DESC))[1],max(f.observed_at),count(*),txid_current()
      FROM purge_states t JOIN metric_facts f ON f.metric_id=t.metric_id AND f.version=t.version AND f.dimensions=t.dimensions
        AND f.observed_at>=t.bucket AND f.observed_at<t.bucket+interval '1 hour' AND f.ends_at IS NULL
      WHERE t.rebuild GROUP BY t.metric_id,t.version,t.bucket,t.dimensions;
      DELETE FROM metric_coverage r USING purge_coverage t WHERE
        (r.source_id,r.metric_id,r.version,r.dimensions,r.starts_at,r.ends_at)=(t.source_id,t.metric_id,t.version,t.dimensions,t.starts_at,t.ends_at)`);
    if(s.startsAt)await c.query(`INSERT INTO metric_coverage
      SELECT source_id,metric_id,version,dimensions,starts_at,$1::timestamptz,received_at FROM purge_coverage WHERE starts_at<$1
      UNION ALL SELECT source_id,metric_id,version,dimensions,$2::timestamptz,ends_at,received_at FROM purge_coverage WHERE ends_at>$2
      ON CONFLICT DO NOTHING`,[s.startsAt,s.endsAt]);
    await c.query(`DELETE FROM metric_dimension_sets d USING purge_dimensions t WHERE d.metric_id=$1 AND d.version=$2 AND d.dimensions=t.dimensions
      AND NOT EXISTS(SELECT 1 FROM metric_facts f WHERE f.metric_id=d.metric_id AND f.version=d.version AND f.dimensions=d.dimensions)
      AND NOT EXISTS(SELECT 1 FROM metric_rollups r WHERE r.metric_id=d.metric_id AND r.version=d.version AND r.dimensions=d.dimensions)
      AND NOT EXISTS(SELECT 1 FROM metric_aggregate_states r WHERE r.metric_id=d.metric_id AND r.version=d.version AND r.dimensions=d.dimensions)
      AND NOT EXISTS(SELECT 1 FROM metric_record_keys r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'projections') p
        WHERE NOT processed AND p->>'metricId'=$1::text AND (p->>'version')::int=$2 AND p->'dimensions'=d.dimensions)`,[m.id,m.version]);
    await c.query('INSERT INTO metric_activity(id,metric_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[uuid(),m.id,actor.id,'measurements_purged',{purgeId,scope:s,counts:preview.counts,reason}]);
    await audit(c,principal,'metrics_purge',m.id);
    return {...preview,id:purgeId,completedAt:new Date().toISOString()};
  });
}
