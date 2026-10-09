import type pg from "pg";
import { check, instant, object } from "@/models/metrics/validation";
import type { MetricQuery } from "@/models/metrics/types";
import type { Distribution } from "@/models/metrics/visualization";
import { getMetric } from "./service";
export async function metricDistribution(
  pool: pg.Pool,
  q: MetricQuery,
): Promise<Distribution> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const m = await getMetric(c, q.metricId, q.version),
      start = instant(q.startsAt),
      end = instant(q.endsAt),
      dimensions = object(q.dimensions ?? {});
    check(
      end > start && Date.parse(end) - Date.parse(start) <= 732 * 86400000,
      "Choose a period of at most 732 days.",
    );
    check(
      m.inputMode !== "aggregates" &&
        !["ratio", "distinct", "count"].includes(m.kind),
      "Distribution requires individual numeric samples, not aggregates, ratios, identities or counts.",
    );
    check(
      Object.entries(dimensions).every(
        ([k, v]) => m.dimensions.includes(k) && typeof v === "string",
      ),
      "Use declared dimension filters.",
    );
    check(
      !q.groupBy?.length,
      "Filter to the desired population without grouping to inspect its sample distribution.",
    );
    const retention = await c.query(
      "SELECT 1 FROM metric_retention_watermarks WHERE metric_id=$1 AND version=$2 AND raw_before>$3",
      [m.id, m.version, start],
    );
    check(
      !retention.rowCount,
      "Individual samples have expired for this period.",
    );
    const params = [m.id, m.version, start, end, JSON.stringify(dimensions)],
      where =
        "metric_id=$1 AND version=$2 AND observed_at>=$3::timestamptz AND observed_at<$4::timestamptz AND dimensions @> $5::jsonb";
    const rows = (
      await c.query(
        `SELECT v::text value,ends_at,n::text,d::text FROM metric_facts WHERE ${where} LIMIT 100001`,
        params,
      )
    ).rows;
    check(
      rows.length <= 100000,
      "Distribution exceeds 100,000 samples. Filter dimensions or shorten the period.",
    );
    check(rows.length > 0, "No retained samples in this period.");
    check(
      rows.every((r) => !r.ends_at),
      "Interval aggregates cannot reconstruct individual samples.",
    );
    // Ordered-set statistics and histogram boundaries stay numeric in PostgreSQL.
    const value = m.kind === "mean" ? "n/nullif(d,0)" : "v";
    const result = (
      await c.query(
        `WITH samples AS(SELECT (${value}) value FROM metric_facts WHERE ${where}), stats AS(SELECT count(value)::int count,min(value) lo,max(value) hi,percentile_disc(0.25) WITHIN GROUP(ORDER BY value) q1,percentile_disc(0.5) WITHIN GROUP(ORDER BY value) median,percentile_disc(0.75) WITHIN GROUP(ORDER BY value) q3 FROM samples), bins AS(SELECT i,CASE WHEN hi=lo THEN lo ELSE lo+(hi-lo)*i/20 END low,CASE WHEN hi=lo THEN hi ELSE lo+(hi-lo)*(i+1)/20 END high FROM stats CROSS JOIN generate_series(0,19) i WHERE hi<>lo OR i=0) SELECT count,lo::text min,hi::text max,q1::text q1,median::text median,q3::text q3,(SELECT jsonb_agg(jsonb_build_object('from',low::text,'to',high::text,'count',(SELECT count(*) FROM samples WHERE value>=low AND (value<high OR high=hi AND value=high))) ORDER BY i) FROM bins) bins FROM stats`,
        params,
      )
    ).rows[0];
    check(result.count > 0, "No eligible numeric samples.");
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
