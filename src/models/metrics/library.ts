import {funnelSteps,type FunnelStep} from './events';
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
  "last_7_days",
  "last_2_years",
] as const;
export type SavedQuery = {
  query: MetricQuery;
  period: (typeof periods)[number];
  compare: boolean;
};
export type SavedEventFunnel = {
 timezone?:string;
 compare?:'none'|'previous_period'|'previous_year'|'custom';
 compareStartsAt?:string;compareEndsAt?:string;
 query: {sourceId:string;datasetKey:string;schemaVersion:number;startsAt:string;endsAt:string;unit:"person"|"account";windowSeconds:number;steps:FunnelStep[]};
 period: (typeof periods)[number];
};
export type LibraryConfig = {
  eventFunnel?: SavedEventFunnel;
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
  if (kind === "query" && config.eventFunnel) {
    check(!config.query,"Choose one query source.");
    const saved=object(config.eventFunnel),q=object(saved.query);
    check(uuid(q.sourceId),"Choose an event source.");
    check(periods.includes(saved.period as never),"Choose a reporting period.");
    check(Number.isInteger(q.schemaVersion)&&Number(q.schemaVersion)>0,"Invalid schema version.");
    check(q.unit==="person"||q.unit==="account","Choose person or account.");
    check(Number.isInteger(q.windowSeconds)&&Number(q.windowSeconds)>=1&&Number(q.windowSeconds)<=90*86400,"Conversion window must be 1 second–90 days.");
    if(saved.period==="fixed")check(instant(q.endsAt)>instant(q.startsAt)&&Date.parse(String(q.endsAt))-Date.parse(String(q.startsAt))<=366*86400000,"Choose a period of at most 366 days.");
    const timezone=String(saved.timezone??'UTC');try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{check(false,'Choose a valid timezone.');}
    const compare=saved.compare??'none';check(['none','previous_period','previous_year','custom'].includes(String(compare)),'Choose a comparison period.');
    if(compare==='custom')check(instant(saved.compareEndsAt)>instant(saved.compareStartsAt)&&Date.parse(String(saved.compareEndsAt))-Date.parse(String(saved.compareStartsAt))<=366*86400000,'Choose a comparison period of at most 366 days.');
    clean.eventFunnel={timezone,compare:compare as SavedEventFunnel['compare'],...(compare==='custom'?{compareStartsAt:instant(saved.compareStartsAt),compareEndsAt:instant(saved.compareEndsAt)}:{}),period:saved.period as SavedEventFunnel["period"],query:{sourceId:String(q.sourceId),datasetKey:text(q.datasetKey,"Dataset"),schemaVersion:Number(q.schemaVersion),startsAt:String(q.startsAt??""),endsAt:String(q.endsAt??""),unit:q.unit,windowSeconds:Number(q.windowSeconds),steps:funnelSteps(q.steps)}};
  } else if (kind === "query") {
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
    const chart = object(config.chart ?? (clean.eventFunnel?{kind:"funnel",stageTotals:true}:{ kind: "line" }));
    if(clean.eventFunnel)check(chart.kind==="funnel","Event funnels require a funnel chart.");
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
    if(clean.eventFunnel)c.stageTotals=true;
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
