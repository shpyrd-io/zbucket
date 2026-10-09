import { check, object, text, instant } from "./validation";
import { chartKinds, type ChartOptions } from "./visualization";
import { queryIntervals } from "./resolution";
import type { MetricQuery } from "./types";
export const periods = [
  "fixed",
  "mtd",
  "last_month",
  "today",
  "yesterday",
  "wtd",
  "last_week",
  "qtd",
  "last_quarter",
  "ytd",
  "last_year",
  "last_30_days",
  "last_2_years",
] as const;
export type SavedQuery = {
  query: MetricQuery;
  period: (typeof periods)[number];
  compare: boolean;
};
export type LibraryConfig = {
  query?: SavedQuery;
  queryIds?: string[];
  viewIds?: string[];
  chart?: ChartOptions;
  layout?: "grid" | "list";
};
export type LibraryItem = {
  id: string;
  name: string;
  kind: "query" | "view" | "dashboard";
  visibility: "private" | "company";
  ownerId: string;
  revision: number;
  config: LibraryConfig;
  updatedAt: string;
};
const uuid = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
export function libraryInput(input: unknown) {
  const d = object(input),
    config = object(d.config),
    kind = d.kind;
  check(
    ["query", "view", "dashboard"].includes(String(kind)),
    "Choose Query, View or Dashboard.",
  );
  check(
    d.visibility === "private" || d.visibility === "company",
    "Choose visibility.",
  );
  let clean: LibraryConfig = {};
  if (kind === "query") {
    const q = object(config.query),
      query = object(q.query);
    check(uuid(query.metricId), "Choose a metric.");
    check(periods.includes(q.period as never), "Choose a reporting period.");
    check(typeof q.compare === "boolean", "Choose comparison.");
    check(
      query.version === undefined || (Number.isInteger(query.version) && Number(query.version) > 0),
      "Invalid legacy metric reference.",
    );
    check(
      queryIntervals.includes(query.interval as never),
      "Choose a query interval.",
    );
    if (q.period === "fixed")
      check(
        instant(query.endsAt) > instant(query.startsAt),
        "Choose a valid fixed period.",
      );
    check(
      query.snapshot !== true,
      "Saved query configurations are not evidence snapshots.",
    );
    // Runtime metric validation remains authoritative for dimensions and reducers.
    const normalized: MetricQuery = {
      metricId: String(query.metricId),
      ...(query.version === undefined ? {} : {version: Number(query.version)}),
      startsAt: String(query.startsAt ?? ""),
      endsAt: String(query.endsAt ?? ""),
      interval: query.interval as MetricQuery["interval"],
      dimensions: object(query.dimensions ?? {}) as Record<string, string>,
      aggregation: query.aggregation as MetricQuery["aggregation"],
      groupBy: query.groupBy as string[],
      groupMode: query.groupMode as MetricQuery["groupMode"],
      groupSelection: query.groupSelection as MetricQuery["groupSelection"],
      groupLimit: query.groupLimit as number,
    };
    clean = {
      query: {
        query: normalized,
        period: q.period as SavedQuery["period"],
        compare: q.compare,
      },
    };
  } else {
    const key = kind === "view" ? "queryIds" : "viewIds",
      ids = config[key];
    check(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= (kind === "view" ? 5 : 32) &&
        ids.every(uuid) &&
        new Set(ids).size === ids.length,
      `Choose 1–${kind === "view" ? 5 : 32} unique ${kind === "view" ? "queries" : "views"}.`,
    );
    clean = { [key]: ids };
  }
  if (kind === "view" || kind === "query") {
    const chart = object(config.chart ?? { kind: "line" });
    check(
      chartKinds.includes(chart.kind as never),
      "Choose a supported chart.",
    );
    const c: ChartOptions = { kind: chart.kind as ChartOptions["kind"] };
    for (const k of ["target", "min", "max", "stateThreshold"] as const)
      if (chart[k] !== undefined) {
        check(
          typeof chart[k] === "number" && Number.isFinite(chart[k]),
          "Use finite chart parameters.",
        );
        c[k] = chart[k];
      }
    for (const k of ["contributions", "stageTotals"] as const)
      if (chart[k] !== undefined) {
        check(typeof chart[k] === "boolean", "Invalid chart confirmation.");
        c[k] = chart[k];
      }
    if (chart.orientation !== undefined) {
      check(chart.orientation === "vertical" || chart.orientation === "horizontal", "Choose a supported chart orientation.");
      c.orientation = chart.orientation;
    }
    clean.chart = c;
  } else {
    check(
      config.layout === "grid" || config.layout === "list",
      "Choose a dashboard layout.",
    );
    clean.layout = config.layout;
  }
  return {
    name: text(d.name, "Name", 160),
    kind: kind as LibraryItem["kind"],
    visibility: d.visibility as LibraryItem["visibility"],
    config: clean,
  };
}
export const references = (item: Pick<LibraryItem, "config">) =>
  item.config.queryIds ?? item.config.viewIds ?? [];
