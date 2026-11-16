import {requestFunnelRun,FunnelProcessing} from './funnel-runs';
import {funnelPeriods} from '@/models/metrics/funnel-periods';
import {eventFunnelPlot} from '@/models/metrics/event-funnel-plot';
import { metricDistribution } from "./distribution";
import type pg from "pg";
import { v7 as uuid } from "uuid";
import { check, object, canonical } from "@/models/metrics/validation";
import {
  libraryInput,
  references,
  type LibraryItem,
  type SavedQuery,
} from "@/models/metrics/library";
import { metricPeriod, previousMonth } from "@/models/metrics/calendar";
import {
  metricPlot,
  combinePlots,
  type PlotData,
} from "@/models/metrics/visualization";
import { queryMetric } from "./query";
import { getMetric } from "./service";
const columns =
  'id,name,kind,visibility,owner_id AS "ownerId",revision,config,updated_at AS "updatedAt"';
export async function libraryList(pool: pg.Pool, actor: string) {
  return (
    await pool.query(
      `SELECT ${columns} FROM metric_library WHERE owner_id=$1 OR visibility='company' ORDER BY updated_at DESC,id LIMIT 1000`,
      [actor],
    )
  ).rows as LibraryItem[];
}
export async function librarySave(
  pool: pg.Pool,
  actor: string,
  input: unknown,
  id?: string,
) {
  const raw = object(input),
    item = libraryInput(raw),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('metric-library'))");
    if (id) {
      const old = (
        await c.query("SELECT * FROM metric_library WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      check(old?.owner_id === actor, "Only the owner can edit this item.", 403);
      check(
        old.revision === raw.revision,
        "This item changed. Reload before saving.",
        409,
      );
      check(old.kind === item.kind, "The item type cannot change.");
      if (item.visibility === "private") {
        const dependents = await c.query(
          "SELECT 1 FROM metric_library WHERE visibility='company' AND (config->'queryIds' ? $1 OR config->'viewIds' ? $1) LIMIT 1",
          [id],
        );
        check(
          !dependents.rowCount,
          "Shared items still reference this item. Make them private first.",
        );
      }
    }
    for (const ref of references(item)) {
      const row = (
        await c.query("SELECT * FROM metric_library WHERE id=$1", [ref])
      ).rows[0];
      check(
        row && (row.owner_id === actor || row.visibility === "company"),
        "Referenced item unavailable.",
        404,
      );
      check(
        row.kind === (item.kind === "view" ? "query" : "view"),
        "Invalid referenced item type.",
      );
      check(
        item.visibility !== "company" || row.visibility === "company",
        "Share the referenced inputs before sharing this item.",
      );
    }
    if(item.config.eventFunnel){
      const q=item.config.eventFunnel.query;
      const row=(await c.query("SELECT mapping FROM metric_event_datasets WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3",[q.sourceId,q.datasetKey,q.schemaVersion])).rows[0];
      check(row?.mapping[q.unit==="person"?"userId":"accountId"],"Event dataset or identity mapping unavailable.",404);
    }
    if (item.config.query) {
      const m = await getMetric(
        c,
        item.config.query.query.metricId,
        item.config.query.query.version,
      );
      check(m, "Metric unavailable.");
    }
    const result = id
      ? await c.query(
          `UPDATE metric_library SET name=$2,visibility=$3,config=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
          [id, item.name, item.visibility, item.config],
        )
      : await c.query(
          `INSERT INTO metric_library(id,name,kind,visibility,owner_id,config) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
          [uuid(), item.name, item.kind, item.visibility, actor, item.config],
        );
    await c.query("COMMIT");
    return result.rows[0];
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function libraryDelete(
  pool: pg.Pool,
  actor: string,
  id: string,
  revision: unknown,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('metric-library'))");
    const old = (
      await c.query(
        "SELECT owner_id,revision FROM metric_library WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    check(old?.owner_id === actor, "Only the owner can delete this item.", 403);
    check(old.revision === revision, "This item changed. Reload first.", 409);
    check(
      !(
        await c.query(
          "SELECT 1 FROM metric_library WHERE config->'queryIds' ? $1 OR config->'viewIds' ? $1 LIMIT 1",
          [id],
        )
      ).rowCount,
      "This item is used by a saved view or dashboard. Remove those references first.",
    );
    await c.query("DELETE FROM metric_library WHERE id=$1", [id]);
    await c.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function runSavedQuery(pool: pg.Pool, s: SavedQuery, now: Date) {
  const m = await getMetric(pool, s.query.metricId, s.query.version);
  const bounds =
    s.period === "fixed"
      ? { startsAt: s.query.startsAt, endsAt: s.query.endsAt }
      : metricPeriod(s.period, m.timezone, now);
  return queryMetric(pool, {
    ...s.query,
    ...bounds,
    snapshot: false,
    ...(s.compare
      ? previousMonth(bounds.startsAt, bounds.endsAt, m.timezone)
      : { compareStartsAt: undefined, compareEndsAt: undefined }),
  });
}
export async function libraryRun(pool: pg.Pool, actor: string, id: string) {
  const items = (
      await pool.query(
        `WITH RECURSIVE picked AS(SELECT m.*,0 depth FROM metric_library m WHERE id=$1 AND (owner_id=$2 OR visibility='company') UNION ALL SELECT child.*,p.depth+1 FROM picked p CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(p.config->'queryIds',p.config->'viewIds','[]'::jsonb)) ref JOIN metric_library child ON child.id::text=ref.value WHERE p.depth<2 AND (child.owner_id=$2 OR child.visibility='company')) SELECT DISTINCT ${columns} FROM picked`,
        [id, actor],
      )
    ).rows as LibraryItem[],
    lookup = new Map(items.map((i) => [i.id, i]));
  const item = lookup.get(id);
  check(item, "Saved item not found.", 404);
  const now = new Date(),
    cache = new Map<string, Promise<PlotData>>();
  const get = (ref: string) => {
    const i = lookup.get(ref);
    check(i, "A referenced input is unavailable.", 404);
    return i;
  };
  const query = (ref: string) => {
    const i = get(ref);
    check(i.kind === "query" && (i.config.query || i.config.eventFunnel), "Invalid query reference.");
    const key = canonical(i.config.eventFunnel ?? i.config.query);
    if (!cache.has(key)) {
      check(
        cache.size < 20,
        "A dashboard can execute at most 20 distinct queries.",
      );
      cache.set(
        key,
        i.config.eventFunnel ? (async()=>{
          const s=i.config.eventFunnel!,bounds=funnelPeriods(s,now),principal={kind:"user" as const,id:actor,name:"Library reader",admin:false};
          const result=await requestFunnelRun(pool,principal,{...s.query,...bounds.current});
          const comparison=bounds.comparison?await requestFunnelRun(pool,principal,{...s.query,...bounds.comparison}):undefined;
          if(result.status!=="completed")throw new FunnelProcessing(result);
          if(comparison&&comparison.status!=="completed")throw new FunnelProcessing(comparison);
          return eventFunnelPlot(result,{...s.query,...bounds.current},comparison,bounds.comparison,bounds.timezone);
        })() : runSavedQuery(pool, i.config.query!, now).then((r) => metricPlot(r)),
      );
    }
    return cache.get(key)!.then((data) => ({ ...data, title: i.name }));
  };
  const view = async (i: LibraryItem) => {
    try {
      let data: PlotData;
      if (i.kind === "query") data = await query(i.id);
      else {
        check(i.kind === "view", "Choose a view.");
        const sources: PlotData[] = [];
        for (const ref of i.config.queryIds ?? [])
          sources.push(await query(ref));
        check(sources.length, "Choose query inputs.");
        if(sources.some(d=>d.measurementKind==="event_funnel"))check(sources.length===1&&i.config.chart?.kind==="funnel","Use one event funnel query in a funnel view. Stage counts cannot be combined or summed.");
        if (sources.length > 1)
          check(
            sources.every(
              (d) =>
                d.timezone === sources[0].timezone &&
                d.interval === sources[0].interval &&
                d.startsAt === sources[0].startsAt &&
                d.endsAt === sources[0].endsAt,
            ),
            "Combined queries must use the same period, interval and timezone.",
          );
        data = sources.length === 1 ? sources[0] : combinePlots(sources);
      }
      check(
        data.series.reduce((n, s) => n + s.points.length, 0) <= 25000,
        "View exceeds 25,000 returned points. Filter dimensions or choose a coarser interval.",
      );
      if (["histogram", "box"].includes(i.config.chart?.kind ?? "")) {
        const qi = i.kind === "query" ? i : get(i.config.queryIds![0]);
        check(
          i.kind === "query" || i.config.queryIds?.length === 1,
          "Use one query for distributions.",
        );
        data = {
          ...data,
          distribution: await metricDistribution(pool, {
            ...qi.config.query!.query,
            startsAt: data.startsAt,
            endsAt: data.endsAt,
          }),
        };
      }
      return {
        id: i.id,
        name: i.name,
        chart: i.config.chart ?? { kind: "line" as const },
        data: { ...data, title: i.name },
      };
    } catch (e) {
      return {
        id: i.id,
        name: i.name,
        chart: i.config.chart ?? { kind: "line" as const },
        error: e instanceof Error ? e.message : "Query failed.",
        ...(e instanceof FunnelProcessing?{processing:['queued','running','invalidated'].includes(e.result.status),runId:e.result.runId,funnelStatus:e.result.status}:{}),
      };
    }
  };
  const panels = [];
  for (const i of item.kind === "dashboard"
    ? (item.config.viewIds ?? []).map(get)
    : [item])
    panels.push(await view(i));
  return { runAt: now.toISOString(), item, panels };
}
