"use client";
import { Input } from "@shpyrd/ui/components/input";
import { Button } from "@shpyrd/ui/components/button";
import { SelectControl } from "./select-control";
import {
  queryIntervals,
  resolutionSeconds,
  type QueryInterval,
  type BaseResolution,
} from "@/models/metrics/resolution";
import type { Metric, MetricQuery, MetricResult } from "@/models/metrics/types";
import {
  dimensionKey,
  dimensionLabel,
  metricPlot,
  type ChartOptions,
  type Distribution,
} from "@/models/metrics/visualization";
import { MetricChart } from "./metric-chart";
import { MetricChartOptions } from "./metric-chart-options";
export type MetricExplorer = {
  interval: QueryInterval;
  aggregation: NonNullable<MetricQuery["aggregation"]>;
  dimensions: Record<string, string>;
  groupBy: string[];
  groupAfter?: string;
  groupMode: "auto" | "selected" | "top";
  groupSearch: string;
  groupSelection: Record<string, string>[];
  groupLimit: number;
  view: ChartOptions["kind"];
  chart: ChartOptions;
};
export const initialExplorer: MetricExplorer = {
  interval: "day",
  aggregation: "sum",
  dimensions: {},
  groupBy: [],
  groupMode: "auto",
  groupSearch: "",
  groupSelection: [],
  groupLimit: 5,
  view: "line",
  chart: { kind: "line" },
};
export function MetricQueryControls({
  metric,
  value,
  onChange,
  result,
  hideChart = false,
}: {
  metric: Metric;
  value: MetricExplorer;
  onChange: (v: MetricExplorer) => void;
  result?: MetricResult;
  hideChart?: boolean;
}) {
  const patch = (v: Partial<MetricExplorer>) =>
    onChange({ ...value, groupAfter: undefined, ...v });
  return (
    <div className="mb-4 grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Interval
          <SelectControl
            value={value.interval}
            onValueChange={(interval) =>
              patch({ interval: interval as QueryInterval })
            }
          >
            {queryIntervals
              .filter(
                (i) =>
                  !metric.storagePolicy ||
                  (resolutionSeconds[i as BaseResolution] ?? Infinity) >=
                    resolutionSeconds[metric.storagePolicy.baseResolution],
              )
              .map((i) => (
                <option value={i} key={i}>
                  {i.replaceAll("_", " ")}
                </option>
              ))}
          </SelectControl>
        </label>
        {metric.kind === "latest" && (
          <label className="text-sm">
            Aggregation
            <SelectControl
              value={value.aggregation}
              onValueChange={(aggregation) =>
                patch({
                  aggregation: aggregation as MetricExplorer["aggregation"],
                })
              }
            >
              {[
                ["sum", "Sum"],
                ["mean", "Average"],
                ["min", "Minimum"],
                ["max", "Maximum"],
              ].map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </SelectControl>
          </label>
        )}
        {!hideChart && (
          <MetricChartOptions
            value={{ ...value.chart, kind: value.view }}
            onChange={(chart) => patch({ chart, view: chart.kind })}
          />
        )}
      </div>
      {metric.kind === "latest" && !!metric.dimensions.length && !value.groupBy.length && result?.lastReceivedAt && result.series.every(point=>point.value===null) && (
        <div className="rounded-md border p-3 text-sm">
          <p className="text-muted-foreground">{metric.missingData==='keep_previous'?'This total needs a known reading for every dimension group.':'This snapshot total needs fresh readings for every dimension group at the same boundary.'} View groups separately to inspect available readings.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {metric.dimensions.map(dimension=><Button key={dimension} type="button" size="sm" variant="outline" onClick={()=>patch({groupBy:[dimension],groupSelection:[],groupMode:"auto",interval:metric.storagePolicy?.baseResolution??"hour"})}>View by {dimension}</Button>)}
          </div>
        </div>
      )}
      {!!metric.dimensions.length && (
        <details open={!!value.groupBy.length}>
          <summary className="cursor-pointer text-sm">
            Filters and grouping{" "}
            {value.groupBy.length ? `· ${value.groupBy.join(", ")}` : ""}
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {metric.dimensions.map((d) => (
              <div className="flex items-end gap-2" key={d}>
                <label className="flex-1 text-sm">
                  {d}
                  <Input
                    placeholder="All values"
                    value={value.dimensions[d] ?? ""}
                    onChange={(e) => {
                      const dimensions = { ...value.dimensions };
                      if (e.target.value) dimensions[d] = e.target.value;
                      else delete dimensions[d];
                      patch({ dimensions });
                    }}
                  />
                </label>
                <label className="mb-2 flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={value.groupBy.includes(d)}
                    disabled={
                      !value.groupBy.includes(d) && value.groupBy.length >= 3
                    }
                    onChange={(e) =>
                      patch({
                        groupBy: e.target.checked
                          ? [...value.groupBy, d]
                          : value.groupBy.filter((k) => k !== d),
                        groupSelection: [],
                        groupMode: "auto",
                      })
                    }
                  />
                  Group by
                </label>
              </div>
            ))}
          </div>
          {!!value.groupBy.length && (
            <div className="metric-group-picker">
              <div className="flex flex-wrap items-center gap-2">
                <SelectControl
                  aria-label="Series selection"
                  value={value.groupMode}
                  onValueChange={(v) =>
                    patch({
                      groupMode: v as MetricExplorer["groupMode"],
                      groupSearch: "",
                    })
                  }
                >
                  <option value="auto">Auto · all if fewer than 10</option>
                  <option value="selected">Select up to 5 series</option>
                  <option value="top">Top series by period value</option>
                </SelectControl>
                {value.groupMode === "top" && (
                  <SelectControl
                    aria-label="Top count"
                    value={String(value.groupLimit)}
                    onValueChange={(v) => patch({ groupLimit: Number(v) })}
                  >
                    <option value="5">Top 5</option>
                    <option value="10">Top 10</option>
                  </SelectControl>
                )}
                <span className="text-xs text-muted-foreground">
                  {result?.groupCount ?? "…"} groups in the filtered period
                </span>
              </div>
              {value.groupMode === "auto" &&
                (result?.groupCount ?? 0) >= 10 && (
                  <p>
                    Showing All. Search and choose up to five series, or use Top
                    5/10.
                  </p>
                )}
              {value.groupMode === "selected" && (
                <>
                  <Input
                    aria-label="Search dimension values"
                    placeholder="Search dimension values…"
                    value={value.groupSearch}
                    onChange={(e) => patch({ groupSearch: e.target.value })}
                  />
                  <div className="metric-group-choices">
                    {[
                      ...new Map(
                        [
                          ...value.groupSelection,
                          ...(result?.groupChoices ?? []).map(
                            (g) => g.dimensions,
                          ),
                        ].map((d) => [dimensionKey(d), d]),
                      ).values(),
                    ].map((d) => {
                      const selected = value.groupSelection.some(
                        (s) => dimensionKey(s) === dimensionKey(d),
                      );
                      return (
                        <label key={dimensionKey(d)}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={
                              !selected && value.groupSelection.length >= 5
                            }
                            onChange={(e) =>
                              patch({
                                groupSelection: e.target.checked
                                  ? [...value.groupSelection, d]
                                  : value.groupSelection.filter(
                                      (s) =>
                                        dimensionKey(s) !== dimensionKey(d),
                                    ),
                              })
                            }
                          />
                          {dimensionLabel(d)}
                        </label>
                      );
                    })}
                  </div>
                  <p>
                    Search examines the eligible groups, not just the visible
                    page. Selection changes the displayed series; dimension
                    filters change the headline total.
                  </p>
                </>
              )}
            </div>
          )}
        </details>
      )}
    </div>
  );
}
export function MetricQueryView({
  result,
  view,
  chart,
  onPage,
  distribution,
  onDrill,
}: {
  result: MetricResult;
  view: MetricExplorer["view"];
  chart?: ChartOptions;
  onPage: (after?: string) => void;
  distribution?: Distribution;
  onDrill?: (startsAt: string, dimensions: Record<string, string>) => void;
}) {
  return (
    <>
      <MetricChart
        data={{ ...metricPlot(result), distribution }}
        options={{ ...chart, kind: view }}
        onDrill={
          onDrill
            ? (p, s) => onDrill(p.original ?? p.key, s.dimensions)
            : undefined
        }
      />
      {result.breakdown?.nextCursor && (
        <div className="my-2 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => onPage()}>
            First groups
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPage(result.breakdown?.nextCursor)}
          >
            Next groups
          </Button>
        </div>
      )}
    </>
  );
}
