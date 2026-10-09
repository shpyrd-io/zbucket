import { describe, it, expect } from "vitest";
import {
  chartIssue,
  decimalSum,
  decimalCompare,
  dimensionKey,
  metricPlot,
  combinePlots,
  type PlotData,
} from "./visualization";
import { libraryInput } from "./library";
import type { MetricResult } from "./types";
export function plotFixture(): PlotData {
  return {
    title: "Revenue",
    unit: "USD",
    timezone: "UTC",
    interval: "day",
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2026-01-03T00:00:00Z",
    series: [
      {
        id: "a",
        name: "A",
        unit: "USD",
        total: "30.10",
        dimensions: { channel: "a" },
        points: [
          { key: "2026-01-01T00:00:00Z", value: "10.05", quality: "complete" },
          { key: "2026-01-02T00:00:00Z", value: "20.05", quality: "complete" },
        ],
      },
      {
        id: "b",
        name: "B",
        unit: "USD",
        total: "20",
        dimensions: { channel: "b" },
        points: [
          { key: "2026-01-01T00:00:00Z", value: "5", quality: "complete" },
          { key: "2026-01-02T00:00:00Z", value: "15", quality: "complete" },
        ],
      },
    ],
    rows: [
      {
        key: "a",
        label: "A",
        dimensions: { channel: "a" },
        value: "30.10",
        previous: "20",
      },
      {
        key: "b",
        label: "B",
        dimensions: { channel: "b" },
        value: "20",
        previous: "30",
      },
    ],
    additive: true,
    partition: true,
    completeGroups: true,
    notes: [],
  };
}
describe("Metric chart semantics", () => {
  it("adds decimal strings exactly beyond JS precision", () => {
    expect(decimalSum(["9007199254740993.10", "0.1"])).toBe(
      "9007199254740993.20",
    );
    expect(decimalSum(["-10.5", "0.05"])).toBe("-10.45");
    expect(decimalCompare("9007199254740993", "9007199254740992")).toBe(1);
  });
  it("normalizes dimension identities independent of object key order", () =>
    expect(dimensionKey({ a: "1", b: "2" })).toBe(
      dimensionKey({ b: "2", a: "1" }),
    ));
  it("rejects incomplete or non-additive pie composition", () => {
    expect(
      chartIssue({ ...plotFixture(), additive: false }, { kind: "pie" }),
    ).toMatch(/additive/);
    expect(
      chartIssue({ ...plotFixture(), completeGroups: false }, { kind: "pie" }),
    ).toMatch(/complete/);
    expect(chartIssue(plotFixture(), { kind: "pie" })).toBeUndefined();
  });
  it("rejects negative composition and missing samples", () => {
    const p = plotFixture();
    p.rows[0].value = "-1";
    expect(chartIssue(p, { kind: "donut" })).toMatch(/nonnegative/);
    expect(chartIssue(p, { kind: "histogram" })).toMatch(/individual samples/);
  });
  it("requires explicit chart semantics for contributions, stages and scales", () => {
    const d = plotFixture();
    expect(chartIssue(d, { kind: "waterfall" })).toMatch(
      /signed contributions/,
    );
    expect(chartIssue(d, { kind: "funnel" })).toMatch(/stage totals/);
    expect(chartIssue(d, { kind: "radar" })).toMatch(/minimum/);
    expect(chartIssue(d, { kind: "matrix" })).toMatch(/two dimensions/);
  });
  it("does not treat combined independent sources as additive parts", () => {
    const p = combinePlots([plotFixture(), plotFixture()]);
    expect(p.additive).toBe(false);
    expect(chartIssue(p, { kind: "pie" })).toMatch(/additive/);
  });
  it("matches comparison groups by keys and preserves gaps and original dates", () => {
    const r = {
      metric: { name: "Sales", unit: "USD", kind: "sum", timezone: "UTC" },
      aggregation: "sum",
      value: "12",
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2026-01-03T00:00:00Z",
      quality: "partial",
      series: [],
      groups: [
        {
          dimensions: { account: "a" },
          series: [
            { startsAt: "2026-01-01T00:00:00Z", value: null, count: "0" },
            { startsAt: "2026-01-02T00:00:00Z", value: "12", count: "1" },
          ],
        },
      ],
      comparison: {
        value: "20",
        startsAt: "2025-12-01T00:00:00Z",
        endsAt: "2025-12-03T00:00:00Z",
        quality: "complete",
        groups: [
          { dimensions: { account: "b" }, series: [] },
          {
            dimensions: { account: "a" },
            series: [
              { startsAt: "2025-12-01T00:00:00Z", value: "20", count: "1" },
            ],
          },
        ],
      },
    } as unknown as MetricResult;
    const p = metricPlot(r);
    expect(p.series[0].points[0].value).toBeNull();
    expect(p.series[1].points.map((p) => p.value)).toEqual(["20", null]);
    expect(p.series[1].points[0].original).toBe("2025-12-01T00:00:00Z");
  });
  it("accepts stable metric identity and rejects arbitrary view types", () => {
    expect(() =>
      libraryInput({
        name: "Test",
        kind: "query",
        visibility: "private",
        config: {
          query: {
            period: "mtd",
            compare: false,
            query: {
              metricId: "00000000-0000-0000-0000-000000000000",
              interval: "day",
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      libraryInput({
        name: "X",
        kind: "view",
        visibility: "private",
        config: {
          queryIds: ["00000000-0000-0000-0000-000000000000"],
          chart: { kind: "javascript" },
        },
      }),
    ).toThrow(/chart/);
  });
});
