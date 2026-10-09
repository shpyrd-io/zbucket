"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type SVGProps,
} from "react";
import { Badge } from "@shpyrd/ui/components/badge";
import { Button } from "@shpyrd/ui/components/button";
import {
  chartIssue,
  compact,
  decimalSum,
  decimalCompare,
  seriesColor,
  type ChartOptions,
  type PlotData,
  type PlotPoint,
  type PlotSeries,
} from "@/models/metrics/visualization";
import {observationLabel} from '@/models/metrics/observations';
import { Table } from "./records";
const W = 860,
  H = 300,
  L = 76,
  R = 828,
  T = 22,
  B = 246;
const color = (id: string) => seriesColor(id);
const dateLabel = (key: string, zone: string, short = false) =>
  /^\d{4}-\d{2}$/.test(key)
    ? key
    : Number.isFinite(Date.parse(key))
      ? new Intl.DateTimeFormat("en", {
          timeZone: zone,
          month: "short",
          day: "numeric",
          ...(!short
            ? { hour: "2-digit" as const, minute: "2-digit" as const }
            : {}),
        }).format(new Date(key))
      : key;
const positive = (value: string | null) => value !== null && Number(value) > 0;
export function MetricChart({
  data,
  options,
  onDrill,
}: {
  data: PlotData;
  options: ChartOptions;
  onDrill?: (point: PlotPoint, series: PlotSeries) => void;
}) {
  const [hidden, setHidden] = useState<string[]>([]),
    [table, setTable] = useState(false),
    [focus, setFocus] = useState(0);
  const id = useId();
  const issue = chartIssue(data, options),
    showTable = table || options.kind === "table";
  const series = data.series.filter((s) => !hidden.includes(s.id));
  const keys = [
    ...new Set(data.series.flatMap((s) => s.points.map((p) => p.key))),
  ].sort();
  const interactive = [
    "line",
    "step",
    "bar",
    "area",
    "stacked_bar",
    "stacked_area",
    "bump",
  ].includes(options.kind);
  const frame = (contents: React.ReactNode, viewBox = `0 0 ${W} ${H}`) => (
    <MetricPlot
      viewBox={viewBox}
      role="img"
      aria-labelledby={id}
      tabIndex={interactive ? 0 : undefined}
      onPointerMove={
        interactive
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setFocus(
                Math.max(
                  0,
                  Math.min(
                    keys.length - 1,
                    Math.floor(
                      ((((e.clientX - r.left) / r.width) * W - L) / (R - L)) *
                        keys.length,
                    ),
                  ),
                ),
              );
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setFocus(
                  Math.max(
                    0,
                    Math.min(
                      keys.length - 1,
                      focus + (e.key === "ArrowLeft" ? -1 : 1),
                    ),
                  ),
                );
              }
            }
          : undefined
      }
    >
      <title id={id}>{`${data.title}. ${data.unit}. Exact values and quality are available in Data.`}</title>
      {contents}
    </MetricPlot>
  );
  const dataTable = (
    <div className="knowledge-table-scroll">
      <Table
        heads={["Period total / group", "Value", "Previous"]}
        rows={data.rows.map((r) => [
          r.label,
          r.value ?? "Unavailable",
          r.previous ?? "—",
        ])}
      />
      <Table
        heads={[
          "Series",
          "Interval / dimension",
          "Value",
          "Unit",
          "Quality",
          "Original interval",
          "Observation history",
        ]}
        rows={data.series
          .flatMap((s) =>
            s.points.map((p) => [
              s.name,
              p.key,
              p.value ?? "Unavailable",
              s.unit,
              p.quality,
              p.original ?? p.key,
              observationLabel(p,data.timezone),
            ]),
          )
          .slice(0, 1000)}
      />
      {data.series.reduce((n, s) => n + s.points.length, 0) > 1000 && (
        <p>
          First 1,000 rows shown. Narrow the query or use the metric export.
        </p>
      )}
    </div>
  );
  let plot: React.ReactNode = null;
  if (!issue && !showTable) {
    if (options.kind === "number")
      plot = (
        <div className="metric-kpis">
          {series
            .filter((s) => !s.comparison)
            .map((s) => (
              <div key={s.id}>
                <p>{s.name}</p>
                <strong title={s.total ?? "Unavailable"}>
                  {compact(s.total)}
                </strong>{" "}
                <span>{s.unit}</span>
                <p className="text-xs text-muted-foreground">{observationLabel(s,data.timezone)}</p>
                <MiniLine series={s} />
              </div>
            ))}
        </div>
      );
    else if (options.kind === "small_multiples")
      plot = (
        <div className="metric-small-multiples">
          {series.map((s) => (
            <div key={s.id}>
              <p>
                {s.name} · {s.unit}
              </p>
              <Cartesian
                data={{ ...data, series: [s] }}
                kind="line"
                frame={frame}
              />
            </div>
          ))}
        </div>
      );
    else if (
      [
        "line",
        "step",
        "bar",
        "area",
        "stacked_bar",
        "stacked_area",
        "bump",
      ].includes(options.kind)
    )
      plot = (
        <Cartesian
          data={{ ...data, series }}
          kind={options.kind}
          frame={frame}
          target={options.target}
          focus={focus}
        />
      );
    else if (
      ["ranking", "dumbbell", "slope", "waterfall", "funnel"].includes(
        options.kind,
      )
    ) {
      const rows = (
        options.kind === "ranking"
          ? [...data.rows].sort((a, b) =>
              a.value === null
                ? 1
                : b.value === null
                  ? -1
                  : decimalCompare(b.value, a.value),
            )
          : data.rows
      ).slice(0, 50);
      const max = Math.max(
        1,
        ...rows.map((r) => Math.abs(Number(r.value ?? 0))),
        ...rows.map((r) => Math.abs(Number(r.previous ?? 0))),
      );
      if (options.kind === "slope")
        plot = frame(
          rows.map((r, i) => {
            const low = Math.min(
                0,
                ...rows.map((r) => Number(r.value ?? 0)),
                ...rows.map((r) => Number(r.previous ?? 0)),
              ),
              y = (v: number) => B - ((v - low) / (max - low)) * (B - T),
              stroke = color(r.key);
            return r.value !== null &&
              r.previous !== null &&
              r.previous !== undefined ? (
              <g key={r.key} stroke={stroke}>
                <title>
                  {r.label}: {r.previous} → {r.value} {data.unit}
                </title>
                <line
                  x1={220}
                  x2={620}
                  y1={y(Number(r.previous))}
                  y2={y(Number(r.value))}
                />
                <circle cx={220} cy={y(Number(r.previous))} r={4} />
                <circle cx={620} cy={y(Number(r.value))} r={4} />
                <text x={40} y={24 + i * 15} stroke="none">
                  {r.label}: {compact(r.previous)} → {compact(r.value)}
                </text>
              </g>
            ) : null;
          }),
        );
      else if (options.kind === "waterfall") {
        let sum = 0;
        const steps = rows.map((r) => {
            const from = sum;
            sum += Number(r.value ?? 0);
            return { r, from, to: sum };
          }),
          low = Math.min(0, ...steps.map((s) => s.to)),
          high = Math.max(1, ...steps.map((s) => s.to)),
          y = (v: number) => B - ((v - low) / (high - low)) * (B - T),
          w = (R - L) / (steps.length + 1);
        plot = frame(
          <>
            <line x1={L} x2={R} y1={y(0)} y2={y(0)} stroke="var(--border)" />
            {steps.map((s, i) => (
              <g key={s.r.key}>
                <title>
                  {s.r.label}: {s.r.value} {data.unit}
                </title>
                <rect
                  x={L + i * w + 4}
                  y={Math.min(y(s.from), y(s.to))}
                  width={w - 8}
                  height={Math.max(1, Math.abs(y(s.to) - y(s.from)))}
                  fill={
                    Number(s.r.value) >= 0 ? "var(--chart-3)" : "var(--chart-1)"
                  }
                />
                <text x={L + i * w + w / 2} y={B + 18} textAnchor="middle">
                  {i + 1}
                </text>
                <text
                  x={L + i * w + w / 2}
                  y={Math.min(y(s.from), y(s.to)) - 4}
                  textAnchor="middle"
                >
                  {compact(s.r.value)}
                </text>
              </g>
            ))}
            <rect
              x={L + steps.length * w + 4}
              y={Math.min(y(0), y(sum))}
              width={w - 8}
              height={Math.abs(y(sum) - y(0))}
              fill="var(--foreground)"
            />
            <text
              x={L + steps.length * w + w / 2}
              y={B + 18}
              textAnchor="middle"
            >
              Total
            </text>
          </>,
        );
      } else
        plot = frame(
          rows.map((r, i) => {
            const yy = 30 + i * 35,
              n = Number(r.value ?? 0),
              prev = r.previous == null ? null : Number(r.previous),
              negative = rows.some(
                (r) => Number(r.value) < 0 || Number(r.previous ?? 0) < 0,
              ),
              start = negative ? 520 : 280,
              x = (v: number) => start + (v / max) * (negative ? 240 : 480);
            return (
              <g key={r.key}>
                <title>
                  {r.label}: {r.value ?? "Unavailable"} {data.unit}
                  {prev !== null ? ` · Previous ${r.previous}` : ""}
                </title>
                <text x={12} y={yy + 4}>
                  {r.label.slice(0, 38)}
                </text>
                {r.value !== null &&
                  (options.kind === "dumbbell" && prev !== null ? (
                    <>
                      <line
                        x1={x(prev)}
                        x2={x(n)}
                        y1={yy}
                        y2={yy}
                        stroke={color(r.key)}
                        strokeWidth={3}
                      />
                      <circle
                        cx={x(prev)}
                        cy={yy}
                        r={5}
                        fill="var(--background)"
                        stroke={color(r.key)}
                      />
                      <circle cx={x(n)} cy={yy} r={5} fill={color(r.key)} />
                    </>
                  ) : (
                    <rect
                      x={
                        options.kind === "funnel"
                          ? start + (480 - (n / max) * 480) / 2
                          : Math.min(start, x(n))
                      }
                      y={yy - 10}
                      width={(Math.abs(n) / max) * (negative ? 240 : 480)}
                      height={20}
                      rx={2}
                      fill={color(r.key)}
                    />
                  ))}
                <text x={805} y={yy + 4} textAnchor="end">
                  {compact(r.value)}
                </text>
              </g>
            );
          }),
          `0 0 860 ${Math.max(100, rows.length * 35 + 25)}`,
        );
    } else if (
      ["pie", "donut", "treemap", "sunburst", "pareto"].includes(options.kind)
    ) {
      const all = data.rows
          .filter((r) => positive(r.value))
          .sort((a, b) => Number(b.value) - Number(a.value)),
        top = all.slice(0, 5),
        rest = all.slice(5);
      const rows = rest.length
          ? [
              ...top,
              {
                key: "other",
                label: "Other",
                dimensions: {},
                value: decimalSum(rest.map((r) => r.value!)),
              },
            ]
          : top,
        total = rows.reduce((v, r) => v + Number(r.value), 0);
      if (options.kind === "treemap")
        plot = frame(
          treeRects(
            rows.map((r, i) => ({ i, value: Number(r.value) })),
            20,
            20,
            820,
            240,
          ).map((b) => {
            const r = rows[b.i];
            return (
              <g key={r.key}>
                <title>
                  {r.label}: {r.value} (
                  {((Number(r.value) / total) * 100).toFixed(1)}%)
                </title>
                <rect
                  x={b.x}
                  y={b.y}
                  width={Math.max(0, b.w - 2)}
                  height={Math.max(0, b.h - 2)}
                  fill={color(r.key)}
                  opacity={0.8}
                />
                {b.w > 90 && b.h > 30 && (
                  <text x={b.x + 8} y={b.y + 24}>
                    {r.label.slice(0, Math.floor(b.w / 8))}
                  </text>
                )}
              </g>
            );
          }),
        );
      else if (options.kind === "pareto") {
        let cumulative = 0;
        plot = frame(
          <>
            {all.slice(0, 50).map((r, i) => {
              const before = cumulative;
              cumulative += Number(r.value) / total;
              const x = L + ((i + 0.5) * (R - L)) / all.length,
                y = B - cumulative * (B - T),
                w = (R - L) / all.length;
              return (
                <g key={r.key}>
                  <title>
                    {r.label}: {r.value}; cumulative{" "}
                    {(cumulative * 100).toFixed(1)}%
                  </title>
                  <rect
                    x={x - w * 0.35}
                    y={B - (Number(r.value) / Number(all[0].value)) * (B - T)}
                    width={w * 0.7}
                    height={(Number(r.value) / Number(all[0].value)) * (B - T)}
                    fill={color(r.key)}
                    opacity={0.65}
                  />
                  {i > 0 && (
                    <line
                      x1={x - w}
                      x2={x}
                      y1={B - before * (B - T)}
                      y2={y}
                      stroke="var(--foreground)"
                    />
                  )}
                  <circle cx={x} cy={y} r={3} fill="var(--foreground)" />
                </g>
              );
            })}
            <text x={R} y={T}>
              100%
            </text>
            <text x={R} y={B}>
              0%
            </text>
          </>,
        );
      } else {
        let angle = -Math.PI / 2;
        const polar = (a: number, r: number) => [
          260 + Math.cos(a) * r,
          140 + Math.sin(a) * r,
        ];
        const wedge = (
          from: number,
          to: number,
          outer: number,
          inner: number,
        ) => {
          const a = polar(from, outer),
            b = polar(to - 0.000001, outer),
            c = polar(to - 0.000001, inner),
            d = polar(from, inner);
          return `M${a}A${outer},${outer} 0 ${to - from > Math.PI ? 1 : 0} 1 ${b}L${c}${inner ? `A${inner},${inner} 0 ${to - from > Math.PI ? 1 : 0} 0 ${d}` : ""}Z`;
        };
        plot = (
          <div className="metric-chart-radial">
            {frame(
              <>
                {(options.kind === "sunburst"
                  ? [...all].sort((a, b) =>
                      a.dimensions[
                        data.dimensionOrder?.[0] ?? Object.keys(a.dimensions)[0]
                      ].localeCompare(
                        b.dimensions[
                          data.dimensionOrder?.[0] ?? Object.keys(b.dimensions)[0]
                        ],
                      ),
                    )
                  : rows
                ).map((r) => {
                  const from = angle;
                  angle += (Number(r.value) / total) * Math.PI * 2;
                  return (
                    <path
                      key={r.key}
                      d={wedge(
                        from,
                        angle,
                        118,
                        options.kind === "pie"
                          ? 0
                          : options.kind === "sunburst"
                            ? 75
                            : 65,
                      )}
                      fill={color(r.key)}
                      stroke="var(--background)"
                      strokeWidth={2}
                    >
                      <title>
                        {r.label}: {r.value} ·{" "}
                        {((Number(r.value) / total) * 100).toFixed(1)}%
                      </title>
                    </path>
                  );
                })}
                {options.kind === "sunburst" &&
                  (() => {
                    const parents = new Map<string, number>();
                    for (const r of [...all].sort((a, b) =>
                      a.dimensions[
                        data.dimensionOrder?.[0] ?? Object.keys(a.dimensions)[0]
                      ].localeCompare(
                        b.dimensions[
                          data.dimensionOrder?.[0] ?? Object.keys(b.dimensions)[0]
                        ],
                      ),
                    )) {
                      const key =
                        r.dimensions[
                          data.dimensionOrder?.[0] ?? Object.keys(r.dimensions)[0]
                        ];
                      parents.set(key, (parents.get(key) ?? 0) + Number(r.value));
                    }
                    let a = -Math.PI / 2;
                    return [...parents].map(([name, v]) => {
                      const from = a;
                      a += (v / total) * Math.PI * 2;
                      return (
                        <path
                          key={name}
                          d={wedge(from, a, 74, 32)}
                          fill={color(name)}
                          stroke="var(--background)"
                        >
                          <title>
                            {name}: {compact(v)}
                          </title>
                        </path>
                      );
                    });
                  })()}
                {options.kind === "donut" && (
                  <text x={260} y={145} textAnchor="middle">
                    {compact(decimalSum(rows.map((r) => r.value!)))}
                  </text>
                )}
              </>,
              "130 10 260 260",
            )}
            <ul className="metric-chart-radial-legend" aria-label="Chart legend">
              {rows.map((r) => (
                <li key={r.key}>
                  <i style={{ background: color(r.key) }} aria-hidden="true" />
                  <span>{r.label}</span>
                  <strong>{((Number(r.value) / total) * 100).toFixed(1)}%</strong>
                </li>
              ))}
            </ul>
          </div>
        );
      }
    } else if (["bullet", "gauge"].includes(options.kind)) {
      const value = Number(series[0]?.total ?? 0),
        min = options.min ?? 0,
        max = options.max ?? 1,
        fraction = (v: number) =>
          Math.max(0, Math.min(1, (v - min) / (max - min))),
        at = fraction(value),
        goal = fraction(options.target ?? 0);
      plot =
        options.kind === "bullet"
          ? frame(
              <>
                <rect
                  x={L}
                  y={90}
                  width={R - L}
                  height={50}
                  rx={3}
                  fill="var(--muted)"
                />
                <rect
                  x={L}
                  y={103}
                  width={(R - L) * at}
                  height={24}
                  rx={2}
                  fill="var(--chart-1)"
                />
                <line
                  x1={L + (R - L) * goal}
                  x2={L + (R - L) * goal}
                  y1={80}
                  y2={150}
                  stroke="var(--foreground)"
                  strokeWidth={3}
                />
                <text x={L} y={180}>
                  {compact(min)}
                </text>
                <text x={R} y={180} textAnchor="end">
                  {compact(max)}
                </text>
                <text x={L} y={55}>
                  {compact(series[0]?.total)} {data.unit} · Target{" "}
                  {options.target}
                </text>
              </>,
            )
          : frame(
              <>
                <path
                  d="M260,210 A170,170 0 0 1 600,210"
                  fill="none"
                  stroke="var(--muted)"
                  strokeWidth={22}
                />
                <path
                  d="M260,210 A170,170 0 0 1 600,210"
                  fill="none"
                  stroke="var(--chart-1)"
                  strokeWidth={22}
                  pathLength={100}
                  strokeDasharray={`${at * 100} 100`}
                />
                <text
                  x={430}
                  y={185}
                  textAnchor="middle"
                  style={{ fontSize: 32 }}
                >
                  {compact(series[0]?.total)}
                </text>
                <text x={260} y={250}>
                  {min}
                </text>
                <text x={600} y={250} textAnchor="end">
                  {max}
                </text>
                <text x={430} y={280} textAnchor="middle">
                  {data.unit} · Target {options.target} (
                  {(goal * 100).toFixed(0)}% of scale)
                </text>
              </>,
            );
    } else if (["scatter", "bubble"].includes(options.kind)) {
      const sources = data.sources;
      const xSeries = sources?.[0]?.series[0] ?? series[0],
        ySeries = sources?.[1]?.series[0] ?? series[1],
        zSeries = sources?.[2]?.series[0] ?? series[2];
      const rows = sources?.every((d) => d.partition)
        ? sources[0].rows
            .filter((r) => !r.other)
            .map((r) => ({
              key: r.key,
              label: r.label,
              x: r.value,
              y: sources[1].rows.find((y) => !y.other && y.key === r.key)
                ?.value,
              z: sources[2]?.rows.find((z) => !z.other && z.key === r.key)
                ?.value,
            }))
        : (xSeries?.points.map((p) => ({
            key: p.key,
            label: p.key,
            x: p.value,
            y: ySeries?.points.find((y) => y.key === p.key)?.value,
            z: zSeries?.points.find((z) => z.key === p.key)?.value,
          })) ?? []);
      const matched = rows.filter(
          (r) =>
            r.x !== null &&
            r.y != null &&
            (options.kind !== "bubble" || (r.z != null && Number(r.z) >= 0)),
        ),
        xs = matched.map((r) => Number(r.x)),
        ys = matched.map((r) => Number(r.y)),
        xmin = Math.min(0, ...xs),
        xmax = Math.max(1, ...xs),
        ymin = Math.min(0, ...ys),
        ymax = Math.max(1, ...ys),
        zmax = Math.max(1, ...matched.map((r) => Number(r.z ?? 1)));
      plot =
        matched.length === 0 ? (
          <p>
            No matching observations. Align the dimension values or reporting
            intervals.
          </p>
        ) : (
          frame(
            <>
              {matched.map((r) => (
                <circle
                  key={r.key}
                  cx={L + ((Number(r.x) - xmin) / (xmax - xmin)) * (R - L)}
                  cy={B - ((Number(r.y) - ymin) / (ymax - ymin)) * (B - T)}
                  r={
                    options.kind === "bubble"
                      ? 4 + Math.sqrt(Number(r.z) / zmax) * 22
                      : 5
                  }
                  fill={color(r.key)}
                  fillOpacity={0.6}
                >
                  <title>
                    {r.label}: X {r.x}; Y {r.y}
                    {r.z ? `; size ${r.z}` : ""}
                  </title>
                </circle>
              ))}
              <text x={L} y={T}>
                {sources?.[1]?.title ?? ySeries?.name} (
                {sources?.[1]?.unit ?? ySeries?.unit}) · {compact(ymin)}–
                {compact(ymax)}
              </text>
              <text x={L} y={285}>
                {sources?.[0]?.title ?? xSeries?.name} (
                {sources?.[0]?.unit ?? xSeries?.unit}) · {compact(xmin)}–
                {compact(xmax)} · {matched.length} matched observations
              </text>
            </>,
          )
        );
    } else if (options.kind === "calendar") {
      const points = series[0]?.points ?? [],
        max = Math.max(1, ...points.map((p) => Math.abs(Number(p.value ?? 0))));
      const parts = (key: string) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: data.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(key));
      const dates = points.map((p) => parts(p.key)),
        months = [...new Set(dates.map((d) => d.slice(0, 7)))];
      plot = (
        <div className="metric-calendar">
          {months.map((month) => (
            <div key={month}>
              <strong>{month}</strong>
              <div className="metric-calendar-grid">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
                {Array.from(
                  { length: new Date(month + "-01T12:00:00Z").getUTCDay() },
                  (_, i) => (
                    <span key={"blank" + i} />
                  ),
                )}
                {Array.from(
                  {
                    length: new Date(
                      Number(month.slice(0, 4)),
                      Number(month.slice(5)),
                      0,
                    ).getDate(),
                  },
                  (_, i) => {
                    const date = month + "-" + String(i + 1).padStart(2, "0"),
                      p = points[dates.indexOf(date)];
                    return (
                      <button
                        key={date}
                        title={`${date}: ${p?.value ?? "Unavailable"} ${data.unit}`}
                        disabled={!p}
                        onClick={() => p && onDrill?.(p, series[0])}
                        style={{
                          background:
                            p?.value != null
                              ? `color-mix(in srgb, var(--chart-1) ${15 + (Math.abs(Number(p.value)) / max) * 75}%, var(--background))`
                              : "var(--muted)",
                        }}
                      >
                        {i + 1}
                      </button>
                    );
                  },
                )}
              </div>
            </div>
          ))}
        </div>
      );
    } else if (options.kind === "matrix" || options.kind === "sankey") {
      const rows = data.rows,
        keys = data.dimensionOrder ?? Object.keys(rows[0]?.dimensions ?? {}),
        xs = [...new Set(rows.map((r) => r.dimensions[keys[0]]))],
        ys = [...new Set(rows.map((r) => r.dimensions[keys[1]]))],
        max = Math.max(1, ...rows.map((r) => Math.abs(Number(r.value ?? 0))));
      if (xs.length > 50 || ys.length > 50)
        plot = <p>Filter dimensions to at most 50 values per axis.</p>;
      else if (options.kind === "matrix")
        plot = frame(
          <>
            {rows.map((r) => {
              const x = xs.indexOf(r.dimensions[keys[0]]),
                y = ys.indexOf(r.dimensions[keys[1]]);
              return (
                <rect
                  key={r.key}
                  x={160 + (x * 640) / xs.length}
                  y={30 + (y * 210) / ys.length}
                  width={640 / xs.length - 2}
                  height={210 / ys.length - 2}
                  fill={r.value === null ? "var(--muted)" : "var(--chart-1)"}
                  opacity={
                    r.value === null
                      ? 1
                      : 0.1 + (Math.abs(Number(r.value)) / max) * 0.9
                  }
                >
                  <title>
                    {r.label}: {r.value ?? "Unavailable"}
                  </title>
                </rect>
              );
            })}
            {ys.map((y, i) => (
              <text
                key={y}
                x={150}
                y={38 + (i * 210) / ys.length}
                textAnchor="end"
              >
                {y.slice(0, 22)}
              </text>
            ))}
            {xs.map((x, i) => (
              <text
                key={x}
                x={160 + ((i + 0.5) * 640) / xs.length}
                y={270}
                textAnchor="middle"
              >
                {x.slice(0, 12)}
              </text>
            ))}
          </>,
        );
      else {
        const total = rows.reduce((v, r) => v + Number(r.value), 0),
          positions = (labels: string[], key: string) => {
            let y = 25;
            return new Map(
              labels.map((label) => {
                const h =
                    (rows
                      .filter((r) => r.dimensions[key] === label)
                      .reduce((v, r) => v + Number(r.value), 0) /
                      total) *
                    200,
                  start = y;
                y += h + 8;
                return [label, { y: start, h, offset: 0 }];
              }),
            );
          },
          left = positions(xs, keys[0]),
          right = positions(ys, keys[1]);
        plot = frame(
          <>
            {rows.map((r) => {
              const a = left.get(r.dimensions[keys[0]])!,
                b = right.get(r.dimensions[keys[1]])!,
                h = (Number(r.value) / total) * 200,
                ay = a.y + a.offset + h / 2,
                by = b.y + b.offset + h / 2;
              a.offset += h;
              b.offset += h;
              return (
                <path
                  key={r.key}
                  d={`M210,${ay} C400,${ay} 450,${by} 640,${by}`}
                  fill="none"
                  stroke={color(r.dimensions[keys[0]])}
                  strokeWidth={Math.max(0.5, h)}
                  opacity={0.35}
                >
                  <title>
                    {r.label}: {r.value}
                  </title>
                </path>
              );
            })}
            {[...left].map(([name, p]) => (
              <g key={name}>
                <rect
                  x={200}
                  y={p.y}
                  width={10}
                  height={p.h}
                  fill={color(name)}
                />
                <text x={190} y={p.y + p.h / 2 + 3} textAnchor="end">
                  {name.slice(0, 25)}
                </text>
              </g>
            ))}
            {[...right].map(([name, p]) => (
              <g key={name}>
                <rect
                  x={640}
                  y={p.y}
                  width={10}
                  height={p.h}
                  fill={color(name)}
                />
                <text x={660} y={p.y + p.h / 2 + 3}>
                  {name.slice(0, 25)}
                </text>
              </g>
            ))}
          </>,
          `0 0 860 ${Math.max(300, 230 + 8 * Math.max(xs.length, ys.length))}`,
        );
      }
    } else if (options.kind === "histogram" || options.kind === "box") {
      const d = data.distribution;
      if (d) {
        const min = Number(d.min),
          max = Number(d.max),
          x = (v: string) =>
            L + ((Number(v) - min) / (max - min || 1)) * (R - L);
        plot = frame(
          options.kind === "box" ? (
            <>
              <line
                x1={x(d.min)}
                x2={x(d.max)}
                y1={120}
                y2={120}
                stroke="var(--foreground)"
              />
              <rect
                x={x(d.q1)}
                y={90}
                width={Math.max(1, x(d.q3) - x(d.q1))}
                height={60}
                fill="var(--chart-1)"
                fillOpacity={0.3}
                stroke="var(--chart-1)"
              />
              <line
                x1={x(d.median)}
                x2={x(d.median)}
                y1={90}
                y2={150}
                stroke="var(--foreground)"
              />
              {[d.min, d.q1, d.median, d.q3, d.max].map((v, i) => (
                <text
                  key={i}
                  x={x(v)}
                  y={185 + (i % 2) * 20}
                  textAnchor="middle"
                >
                  {compact(v)}
                </text>
              ))}
              <text x={L} y={260}>
                Min / Q1 / median / Q3 / max · {d.count} retained individual
                observations
              </text>
            </>
          ) : (
            <>
              {d.bins.map((b, i) => {
                const width = (R - L) / d.bins.length,
                  height =
                    (b.count / Math.max(1, ...d.bins.map((b) => b.count))) *
                    (B - T);
                return (
                  <rect
                    key={i}
                    x={L + i * width}
                    y={B - height}
                    width={Math.max(1, width - 2)}
                    height={height}
                    fill="var(--chart-1)"
                  >
                    <title>
                      {b.from}–{b.to}: {b.count} observations
                    </title>
                  </rect>
                );
              })}
              <text x={L} y={280}>
                {d.min} — {d.max} {data.unit} · {d.count} observations
              </text>
            </>
          ),
        );
      }
    } else if (options.kind === "radar") {
      const rows = data.rows.slice(0, 12),
        n = rows.length,
        point = (i: number, f: number) => [
          430 + Math.cos((i / n) * 2 * Math.PI - Math.PI / 2) * f * 105,
          145 + Math.sin((i / n) * 2 * Math.PI - Math.PI / 2) * f * 105,
        ];
      plot = frame(
        <>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <polygon
              key={f}
              points={rows.map((_, i) => point(i, f).join(",")).join(" ")}
              fill="none"
              stroke="var(--border)"
            />
          ))}
          <polygon
            points={rows
              .map((r, i) =>
                point(
                  i,
                  Math.max(
                    0,
                    Math.min(
                      1,
                      (Number(r.value) - options.min!) /
                        (options.max! - options.min!),
                    ),
                  ),
                ).join(","),
              )
              .join(" ")}
            fill="var(--chart-1)"
            fillOpacity={0.2}
            stroke="var(--chart-1)"
          />
          {rows.map((r, i) => {
            const [x, y] = point(i, 1.22);
            return (
              <text key={r.key} x={x} y={y} textAnchor="middle">
                {r.label.slice(0, 26)}
              </text>
            );
          })}
          <text x={20} y={280}>
            Normalized range {options.min}–{options.max}; values outside range
            are clipped.
          </text>
        </>,
      );
    } else if (options.kind === "state")
      plot = frame(
        series.map((s, i) => (
          <g key={s.id}>
            <text x={12} y={30 + i * 32}>
              {s.name.slice(0, 24)}
            </text>
            {s.points.map((p, j) => (
              <rect
                key={p.key}
                x={220 + (j * 600) / s.points.length}
                y={16 + i * 32}
                width={600 / s.points.length}
                height={22}
                fill={
                  p.value === null
                    ? "var(--muted)"
                    : Number(p.value) >= options.stateThreshold!
                      ? "var(--chart-3)"
                      : "var(--chart-1)"
                }
              >
                <title>
                  {p.key} · {p.value ?? "Unavailable"} ·{" "}
                  {p.value === null
                    ? "Missing"
                    : Number(p.value) >= options.stateThreshold!
                      ? "At or above threshold"
                      : "Below threshold"}
                </title>
              </rect>
            ))}
          </g>
        )),
        `0 0 860 ${Math.max(90, series.length * 32 + 40)}`,
      );
  }
  return (
    <figure className="metric-chart">
      <figcaption>
        <div>
          <strong>{data.title}</strong>
          <p>
            {data.unit} · {data.interval} · {data.timezone}{" "}
            {data.quality && <Badge variant="outline">{data.quality}</Badge>}
          </p>
          <p>
            {data.startsAt.slice(0, 10)} — {data.endsAt.slice(0, 10)}{" "}
            (exclusive)
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTable(!table)}
          aria-pressed={showTable}
        >
          {showTable ? "Chart" : "Data"}
        </Button>
      </figcaption>
      {showTable ? (
        dataTable
      ) : issue ? (
        <p className="metric-chart-notice" role="status">
          {issue}
        </p>
      ) : (
        plot
      )}
      {!showTable &&
        !issue &&
        [
          "line",
          "step",
          "area",
          "bar",
          "stacked_bar",
          "stacked_area",
          "bump",
        ].includes(options.kind) && (
          <div className="metric-chart-inspect">
            <label>
              Inspect interval
              <input
                type="range"
                min={0}
                max={Math.max(0, keys.length - 1)}
                value={Math.min(focus, keys.length - 1)}
                onChange={(e) => setFocus(Number(e.target.value))}
              />
            </label>
            <span>{dateLabel(keys[focus] ?? "", data.timezone)}</span>
            {series.map((s) => {
              const p = s.points.find((p) => p.key === keys[focus]);
              return (
                <button
                  key={s.id}
                  disabled={!p || !onDrill}
                  onClick={() => p && onDrill?.(p, s)}
                  title={`${p?.value ?? "Unavailable"} · ${observationLabel(p??{},data.timezone)}`}
                >
                  {s.name}: {compact(p?.value ?? null)} {s.unit} ·{" "}
                  {p?.quality ?? "missing"}
                  {p?.observedAt&&<span className="block text-xs text-muted-foreground">{observationLabel(p,data.timezone)}</span>}
                </button>
              );
            })}
          </div>
        )}
      {!showTable &&
        !issue &&
        [
          "line",
          "step",
          "bar",
          "area",
          "stacked_bar",
          "stacked_area",
          "small_multiples",
          "number",
          "bump",
        ].includes(options.kind) && (
          <div className="metric-chart-legend">
            {data.series.map((s) => (
              <button
                key={s.id}
                aria-pressed={!hidden.includes(s.id)}
                onClick={() =>
                  setHidden(
                    hidden.includes(s.id)
                      ? hidden.filter((id) => id !== s.id)
                      : [...hidden, s.id],
                  )
                }
              >
                <span
                  style={{
                    background: color(s.id),
                    opacity: hidden.includes(s.id) ? 0.25 : 1,
                  }}
                />
                {s.name}
                {s.projection ? " · Estimated" : ""}
              </button>
            ))}
          </div>
        )}
      {hidden.length > 0 && (
        <p>Legend visibility only; query filters and totals are unchanged.</p>
      )}
      {data.notes.length > 0 && (
        <details className="metric-chart-notes">
          <summary>Query details</summary>
          {data.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </details>
      )}
    </figure>
  );
}
// Keep labels readable when a dashboard card is narrower than SVG coordinates.
function MetricPlot({ viewBox, style, ...props }: SVGProps<SVGSVGElement>) {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const coordinateWidth = Number(viewBox?.split(" ")[2] ?? W);
  const labelSize = width > 0
    ? Math.max(13, Math.min(30, (12 * coordinateWidth) / width))
    : 13;
  return (
    <svg
      {...props}
      ref={ref}
      viewBox={viewBox}
      style={{ ...style, "--metric-label-size": `${labelSize}px` } as CSSProperties}
    />
  );
}

function Cartesian({
  data,
  kind,
  frame,
  target,
  focus,
}: {
  data: PlotData;
  kind: string;
  frame: (x: React.ReactNode) => React.ReactNode;
  target?: number;
  focus?: number;
}) {
  const series = data.series,
    keys = [
      ...new Set(series.flatMap((s) => s.points.map((p) => p.key))),
    ].sort();
  const maps = series.map(
      (s) => new Map(s.points.map((p) => [p.key, p.value])),
    ),
    stack = kind.startsWith("stacked"),
    rank = kind === "bump";
  const values = maps.flatMap((m) =>
    [...m.values()].filter((v) => v !== null).map(Number),
  );
  if (target !== undefined) values.push(target);
  const sums = keys.map((k) =>
      maps.reduce((v, m) => v + Number(m.get(k) ?? 0), 0),
    ),
    low = rank ? 1 : Math.min(0, ...values),
    high = rank
      ? Math.max(2, series.length)
      : Math.max(1, ...values, ...(stack ? sums : [])),
    x = (i: number) => L + ((i + 0.5) * (R - L)) / Math.max(1, keys.length),
    y = (v: number) =>
      rank
        ? T + ((v - low) / (high - low)) * (B - T)
        : B - ((v - low) / (high - low)) * (B - T);
  if (series.length * keys.length > 10000)
    return (
      <p>
        Choose a coarser interval or fewer groups to display at most 10,000
        points.
      </p>
    );
  return frame(
    <>
      {focus !== undefined && keys.length > 0 && (
        <line
          x1={x(Math.min(focus, keys.length - 1))}
          x2={x(Math.min(focus, keys.length - 1))}
          y1={T}
          y2={B}
          stroke="var(--muted-foreground)"
          strokeDasharray="2 4"
          opacity={0.6}
        />
      )}
      {Array.from({ length: 5 }, (_, i) => {
        const v = low + ((high - low) * i) / 4;
        return (
          <g key={i}>
            <line x1={L} x2={R} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text x={L - 12} y={y(v) + 4} textAnchor="end">
              {compact(v)}
            </text>
          </g>
        );
      })}
      {target !== undefined && (
        <g>
          <line
            x1={L}
            x2={R}
            y1={y(target)}
            y2={y(target)}
            stroke="var(--foreground)"
            strokeDasharray="4 4"
          />
          <text x={R} y={y(target) - 6} textAnchor="end">
            Target {target}
          </text>
        </g>
      )}
      {series.map((s, si) => {
        const nums = keys.map((k) => {
          const v = maps[si].get(k);
          if (v == null) return null;
          if (rank) {
            const sorted = maps
              .map((m, i) => ({ i, v: m.get(k) }))
              .filter((x) => x.v != null)
              .sort((a, b) => Number(b.v) - Number(a.v) || a.i - b.i);
            return sorted.findIndex((x) => x.i === si) + 1;
          }
          return Number(v);
        });
        const baseline = (i: number) =>
          stack
            ? maps
                .slice(0, si)
                .reduce((v, m) => v + Number(m.get(keys[i]) ?? 0), 0)
            : 0;
        return (
          <g key={s.id} fill={color(s.id)} stroke={color(s.id)}>
            {s.anchor &&
              kind === "line" &&
              s.points[0]?.value != null &&
              keys.includes(s.anchor.key) && (
                <line
                  data-projection-connector="true"
                  x1={x(keys.indexOf(s.anchor.key))}
                  y1={y(Number(s.anchor.value))}
                  x2={x(keys.indexOf(s.points[0].key))}
                  y2={y(Number(s.points[0].value))}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                />
              )}
            {nums.map((n, i) => {
              if (n === null) return null;
              if (stack && maps.some((m) => m.get(keys[i]) == null))
                return null;
              const base = baseline(i),
                prev = nums[i - 1],
                w = (R - L) / Math.max(1, keys.length),
                bar = kind === "bar" || kind === "stacked_bar";
              return (
                <g key={keys[i]}>
                  <title>{`${s.name} · ${keys[i]}: ${maps[si].get(keys[i])} ${s.unit} · ${observationLabel(s.points.find(p=>p.key===keys[i])??{},data.timezone)}`}</title>
                  {bar ? (
                    <rect
                      x={
                        x(i) -
                        w * 0.4 +
                        (stack ? 0 : (si * w * 0.8) / series.length)
                      }
                      y={Math.min(y(base), y(base + n))}
                      width={Math.max(
                        0.5,
                        (w * 0.8) / (stack ? 1 : series.length) - 1,
                      )}
                      height={Math.max(0.5, Math.abs(y(base + n) - y(base)))}
                      opacity={s.comparison ? 0.45 : 0.8}
                    />
                  ) : (
                    <>
                      {i > 0 &&
                        prev !== null &&
                        (!stack ||
                          maps.every((m) => m.get(keys[i - 1]) != null)) && (
                          <>
                            {(kind === "area" || kind === "stacked_area") && (
                              <path
                                d={`M${x(i - 1)},${y(prev + baseline(i - 1))}L${x(i)},${y(n + base)}L${x(i)},${y(base)}L${x(i - 1)},${y(baseline(i - 1))}Z`}
                                fillOpacity={0.16}
                                stroke="none"
                              />
                            )}
                            <path
                              d={
                                kind === "step"
                                  ? `M${x(i - 1)},${y(prev)}H${x(i)}V${y(n)}`
                                  : `M${x(i - 1)},${y(prev + baseline(i - 1))}L${x(i)},${y(n + base)}`
                              }
                              fill="none"
                              strokeWidth={2}
                              strokeDasharray={
                                s.comparison || s.projection || s.points.find(p=>p.key===keys[i])?.quality==='stale' ? "5 4" : undefined
                              }
                            />
                          </>
                        )}
                      {(keys.length < 80 || (prev == null && nums[i + 1] == null)) && (
                        <circle
                          cx={x(i)}
                          cy={y(n + base)}
                          r={2.5}
                          strokeWidth={1}
                          fill={
                            s.points.find((p) => p.key === keys[i])?.quality ===
                            "complete"
                              ? color(s.id)
                              : "var(--background)"
                          }
                        />
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
      {keys.map((key, i) =>
        i % Math.max(1, Math.ceil(keys.length / 7)) === 0 ? (
          <text key={key} x={x(i)} y={278} textAnchor="middle">
            <tspan x={x(i)}>{dateLabel(key, data.timezone, true)}</tspan>
            {["minute", "5_minutes", "15_minutes", "hour"].includes(data.interval) && Number.isFinite(Date.parse(key)) && (
              <tspan x={x(i)} dy={14}>
                {new Intl.DateTimeFormat("en", {timeZone:data.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(key))}
              </tspan>
            )}
          </text>
        ) : null,
      )}
    </>,
  );
}
function MiniLine({ series }: { series: PlotSeries }) {
  const values = series.points
      .filter((p) => p.value !== null)
      .map((p) => Number(p.value)),
    low = Math.min(...values),
    span = Math.max(...values) - low || 1;
  return (
    <svg viewBox="0 0 200 40" aria-hidden="true">
      {series.points.map((p, i) => {
        const prev = series.points[i - 1];
        return i && p.value !== null && prev.value !== null ? (
          <line
            key={p.key}
            x1={((i - 1) / Math.max(1, series.points.length - 1)) * 200}
            x2={(i / Math.max(1, series.points.length - 1)) * 200}
            y1={38 - ((Number(prev.value) - low) / span) * 36}
            y2={38 - ((Number(p.value) - low) / span) * 36}
            stroke={color(series.id)}
            strokeWidth={2}
          />
        ) : null;
      })}
    </svg>
  );
}

function treeRects(
  items: { i: number; value: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
): { i: number; x: number; y: number; w: number; h: number }[] {
  if (!items.length) return [];
  if (items.length === 1) return [{ i: items[0].i, x, y, w, h }];
  const total = items.reduce((n, i) => n + i.value, 0);
  let cut = 1,
    sum = items[0].value;
  while (cut < items.length - 1 && sum < total / 2) {
    sum += items[cut].value;
    cut++;
  }
  const ratio = sum / total;
  return w >= h
    ? [
        ...treeRects(items.slice(0, cut), x, y, w * ratio, h),
        ...treeRects(items.slice(cut), x + w * ratio, y, w * (1 - ratio), h),
      ]
    : [
        ...treeRects(items.slice(0, cut), x, y, w, h * ratio),
        ...treeRects(items.slice(cut), x, y + h * ratio, w, h * (1 - ratio)),
      ];
}
