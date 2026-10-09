"use client";
import { Input } from "@shpyrd/ui/components/input";
import { SelectControl } from "./select-control";
import {
  chartKinds,
  chartNames,
  type ChartOptions,
} from "@/models/metrics/visualization";
export function MetricChartOptions({
  value,
  onChange,
}: {
  value: ChartOptions;
  onChange: (v: ChartOptions) => void;
}) {
  return (
    <div className="metric-chart-options">
      <label>
        Visualization
        <SelectControl
          value={value.kind === "funnel" ? `funnel_${value.orientation ?? "vertical"}` : value.kind}
          onValueChange={kind => onChange(kind.startsWith("funnel_")
            ? { ...value, kind: "funnel", orientation: kind === "funnel_horizontal" ? "horizontal" : "vertical" }
            : { ...value, kind: kind as ChartOptions["kind"] })}
        >
          {chartKinds.flatMap(k => k === "funnel"
            ? [<option key="funnel_vertical" value="funnel_vertical">Funnel · vertical</option>, <option key="funnel_horizontal" value="funnel_horizontal">Funnel · horizontal</option>]
            : [<option key={k} value={k}>{chartNames[k]}</option>])}
        </SelectControl>
      </label>
      {(["bullet", "gauge", "radar"].includes(value.kind)
        ? [
            "min",
            "max",
            ...(["bullet", "gauge"].includes(value.kind) ? ["target"] : []),
          ]
        : ["line", "step", "bar", "area"].includes(value.kind)
          ? ["target"]
          : value.kind === "state"
            ? ["stateThreshold"]
            : []
      ).map((k) => (
        <label key={k}>
          {
            (
              {
                min: "Minimum",
                max: "Maximum",
                target: "Reference / target",
                stateThreshold: "State threshold",
              } as Record<string, string>
            )[k]
          }
          <Input
            type="number"
            step="any"
            value={
              value[k as keyof ChartOptions] === undefined
                ? ""
                : String(value[k as keyof ChartOptions])
            }
            onChange={(e) =>
              onChange({
                ...value,
                [k]: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
      ))}
      {value.kind === "waterfall" && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!value.contributions}
            onChange={(e) =>
              onChange({ ...value, contributions: e.target.checked })
            }
          />
          Rows are signed contributions to one total
        </label>
      )}
      {value.kind === "funnel" && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!value.stageTotals}
            onChange={(e) =>
              onChange({ ...value, stageTotals: e.target.checked })
            }
          />
          Show ordered stage totals (no cohort inference)
        </label>
      )}
    </div>
  );
}
