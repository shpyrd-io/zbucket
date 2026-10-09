"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@shpyrd/ui/components/button";
import { Input } from "@shpyrd/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@shpyrd/ui/components/dialog";
import { SelectControl } from "./select-control";
import { useSaveMetricLibrary } from "@/hooks/metric-library";
import { periods, type SavedQuery } from "@/models/metrics/library";
import type { MetricQuery } from "@/models/metrics/types";
import type { ChartOptions } from "@/models/metrics/visualization";
export function SaveMetricQuery({
  query,
  name,
  period,
  compare,
  chart,
}: {
  query: MetricQuery;
  name: string;
  period: string;
  compare: boolean;
  chart: ChartOptions;
}) {
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [visibility, setVisibility] = useState("private"),
    [saved, setSaved] = useState(""),
    save = useSaveMetricLibrary();
  return (
    <>
      <Button
        variant="outline"
        disabled={!query.metricId}
        onClick={() => {
          setTitle(name);
          setSaved("");
          setOpen(true);
        }}
      >
        Save query
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save query</DialogTitle>
            <DialogDescription>
              Reuse the metric, filters and reporting period in views and
              dashboards.
            </DialogDescription>
          </DialogHeader>
          {saved ? (
            <div className="grid gap-3">
              <p>Query saved.</p>
              <Link
                href={`/metrics?workspace=studio&item=${saved}`}
                className="table-link"
              >
                Open saved query →
              </Link>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const item = await save
                  .mutateAsync({
                    name: title,
                    kind: "query",
                    visibility: visibility as "private" | "company",
                    config: {
                      query: {
                        query: {
                          ...query,
                          groupAfter: undefined,
                          groupSearch: undefined,
                          snapshot: false,
                        },
                        period: (periods.includes(period as never)
                          ? period
                          : "fixed") as SavedQuery["period"],
                        compare,
                      },
                      chart,
                    },
                  })
                  .catch(() => null);
                if (item) setSaved(item.id);
              }}
            >
              <label>
                Name
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={160}
                />
              </label>
              <label>
                Visibility
                <SelectControl value={visibility} onValueChange={setVisibility}>
                  <option value="private">Only me</option>
                  <option value="company">Company</option>
                </SelectControl>
              </label>
              <p className="text-xs text-muted-foreground">
                {period === "custom" || period === "latest"
                  ? "Dates are fixed."
                  : `${period.replaceAll("_", " ")} is resolved each time this query runs.`}{" "}
                Saved queries use this metric and refresh their results when run.
                Attach evidence to preserve a snapshot.
              </p>
              {save.error && <p role="alert">{save.error.message}</p>}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save query"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
