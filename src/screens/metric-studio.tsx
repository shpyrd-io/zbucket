"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@shpyrd/ui/components/button";
import { Input } from "@shpyrd/ui/components/input";
import { Badge } from "@shpyrd/ui/components/badge";
import { SelectControl } from "@/components/select-control";
import { MetricChart } from "@/components/metric-chart";
import { MetricChartOptions } from "@/components/metric-chart-options";
import {
  MetricQueryControls,
  initialExplorer,
} from "@/components/metric-query-controls";
import {
  useMetricLibrary,
  useSaveMetricLibrary,
  useDeleteMetricLibrary,
  useRunMetricLibrary,
} from "@/hooks/metric-library";
import { useMetricDetail, useMetricQuery } from "@/hooks/metrics";
import { metricPeriod, previousMonth } from "@/models/metrics/calendar";
import {
  periods,
  type LibraryItem,
  type SavedQuery,
} from "@/models/metrics/library";
export function MetricStudio({ viewerId }: { viewerId: string }) {
  const router = useRouter(),
    params = useSearchParams(),
    selectedId = params.get("item") ?? "",
    library = useMetricLibrary(),
    save = useSaveMetricLibrary(),
    remove = useDeleteMetricLibrary();
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [libraryOpen, setLibraryOpen] = useState(true),
    [draft, setDraft] = useState<Partial<LibraryItem> | null>(null),
    [error, setError] = useState("");
  const items = library.data ?? [],
    selected = items.find((i) => i.id === selectedId),
    run = useRunMetricLibrary(draft ? "" : selectedId),
    shown = items.filter(
      (i) =>
        (!filter || i.kind === filter) &&
        i.name.toLowerCase().includes(search.toLowerCase()),
    );
  const create = (kind: "view" | "dashboard") => {
    setError("");
    setDraft({
      kind,
      name: "",
      visibility: "private",
      config:
        kind === "view"
          ? {
              queryIds: selected?.kind === "query" ? [selected.id] : [],
              chart: { kind: "line" },
            }
          : {
              viewIds: selected?.kind === "view" ? [selected.id] : [],
              layout: "grid",
            },
    });
  };
  const change = (patch: Partial<LibraryItem>) =>
    setDraft({ ...draft, ...patch });
  const submit = async () => {
    setError("");
    try {
      const i = await save.mutateAsync(draft!);
      setDraft(null);
      router.push("/metrics?workspace=studio&item=" + i.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  };
  return (
    <div
      className="knowledge-workspace metric-studio"
      data-library-open={libraryOpen}
    >
      <header className="knowledge-toolbar">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={libraryOpen ? "Hide library" : "Show library"}
            title={libraryOpen ? "Hide library" : "Show library"}
            aria-expanded={libraryOpen}
            aria-controls="metric-library-navigation"
            onClick={() => setLibraryOpen(!libraryOpen)}
          >
            {libraryOpen ? (
              <PanelLeftClose aria-hidden="true" />
            ) : (
              <PanelLeftOpen aria-hidden="true" />
            )}
          </Button>
          <Link href="/metrics" className="text-sm table-link">
            Metrics
          </Link>
          <h1 className="text-lg font-semibold">Library</h1>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement)?.blur();
          }}
          className="metric-library-search"
        >
          <Input
            aria-label="Search library"
            placeholder="Search queries, views and dashboards…"
            value={search}
            onFocus={() => setLibraryOpen(true)}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <Button variant="outline" onClick={() => create("view")}>
          New view
        </Button>
        <Button onClick={() => create("dashboard")}>New dashboard</Button>
      </header>
      <div className="knowledge-browser">
        <aside
          id="metric-library-navigation"
          className="knowledge-navigation"
          hidden={!libraryOpen}
        >
          <div className="p-3">
            <SelectControl
              aria-label="Library type"
              value={filter}
              onValueChange={setFilter}
            >
              <option value="">All saved items</option>
              <option value="query">Queries</option>
              <option value="view">Views</option>
              <option value="dashboard">Dashboards</option>
            </SelectControl>
          </div>
          <nav
            className="knowledge-document-list"
            aria-label="Saved metric items"
          >
            {shown.map((i) => (
              <Link
                key={i.id}
                href={`/metrics?workspace=studio&item=${i.id}`}
                scroll={false}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
                data-keyboard-item
                aria-current={selectedId === i.id ? "page" : undefined}
                className="knowledge-document-link text-sm"
              >
                <span>{i.name}</span>
                <small className="block text-muted-foreground">
                  {i.kind} ·{" "}
                  {i.visibility === "private" ? "Only me" : "Company"} · v
                  {i.revision}
                </small>
              </Link>
            ))}
            {!shown.length && (
              <p className="p-4 text-sm text-muted-foreground">
                {library.isPending
                  ? "Loading…"
                  : "Save a query from Metrics to start building your library."}
              </p>
            )}
          </nav>
        </aside>
        <section className="knowledge-reader" aria-label="Library detail">
          {error && (
            <p role="alert" className="mb-3">
              {error}
            </p>
          )}
          {library.error && <p role="alert">{library.error.message}</p>}
          {draft ? (
            <form
              className="metric-studio-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <h2 className="text-xl font-semibold">
                {draft.id ? "Edit" : "New"} {draft.kind}
              </h2>
              <label>
                Name
                <Input
                  required
                  autoFocus
                  maxLength={160}
                  value={draft.name ?? ""}
                  onChange={(e) => change({ name: e.target.value })}
                />
              </label>
              <label>
                Visibility
                <SelectControl
                  value={draft.visibility ?? "private"}
                  onValueChange={(visibility) =>
                    change({
                      visibility: visibility as LibraryItem["visibility"],
                    })
                  }
                >
                  <option value="private">Only me</option>
                  <option value="company">Company</option>
                </SelectControl>
              </label>
              {draft.kind === "query" && draft.config?.query && (
                <QueryEditor
                  config={draft.config.query}
                  onChange={(query) =>
                    change({ config: { ...draft.config, query } })
                  }
                />
              )}
              {draft.kind !== "query" && (
                <>
                  <p className="text-sm">
                    {draft.kind === "view"
                      ? "Choose up to five saved queries. Combined queries use matching dates, intervals and reporting timezones."
                      : "Choose up to twelve saved views. Order below controls panel order."}
                  </p>
                  <div className="metric-library-choices">
                    {items
                      .filter(
                        (i) =>
                          i.kind === (draft.kind === "view" ? "query" : "view"),
                      )
                      .map((i) => {
                        const key =
                            draft.kind === "view" ? "queryIds" : "viewIds",
                          refs = draft.config?.[key] ?? [],
                          chosen = refs.includes(i.id);
                        return (
                          <label className="metric-library-choice" key={i.id}>
                            <input
                              type="checkbox"
                              checked={chosen}
                              disabled={
                                !chosen &&
                                refs.length >= (draft.kind === "view" ? 5 : 12)
                              }
                              onChange={(e) =>
                                change({
                                  config: {
                                    ...draft.config,
                                    [key]: e.target.checked
                                      ? [...refs, i.id]
                                      : refs.filter((id) => id !== i.id),
                                  },
                                })
                              }
                            />
                            <span className="flex-1">{i.name}</span>
                            <Badge variant="outline">{i.visibility}</Badge>
                          </label>
                        );
                      })}
                  </div>
                  <div>
                    {(
                      draft.config?.queryIds ??
                      draft.config?.viewIds ??
                      []
                    ).map((id, index, refs) => (
                      <div className="metric-library-choice" key={id}>
                        <span className="flex-1">
                          {index + 1}.{" "}
                          {items.find((i) => i.id === id)?.name ??
                            "Unavailable"}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          type="button"
                          disabled={!index}
                          onClick={() => {
                            const next = [...refs];
                            [next[index - 1], next[index]] = [
                              next[index],
                              next[index - 1],
                            ];
                            change({
                              config: {
                                ...draft.config,
                                [draft.kind === "view"
                                  ? "queryIds"
                                  : "viewIds"]: next,
                              },
                            });
                          }}
                        >
                          Move up
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {draft.kind === "dashboard" ? (
                <label>
                  Layout
                  <SelectControl
                    value={draft.config?.layout ?? "grid"}
                    onValueChange={(layout) =>
                      change({
                        config: {
                          ...draft.config,
                          layout: layout as "grid" | "list",
                        },
                      })
                    }
                  >
                    <option value="grid">Two columns</option>
                    <option value="list">Full width</option>
                  </SelectControl>
                </label>
              ) : (
                <MetricChartOptions
                  value={draft.config?.chart ?? { kind: "line" }}
                  onChange={(chart) =>
                    change({ config: { ...draft.config, chart } })
                  }
                />
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save and preview"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : selected ? (
            <>
              <header className="metric-library-heading flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">{selected.name}</h2>
                  <p className="metric-library-summary">
                    {selected.kind} ·{" "}
                    {selected.visibility === "private" ? "Only me" : "Company"}{" "}
                    · Revision {selected.revision}
                  </p>
                </div>
                <div className="metric-studio-actions flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void run.refetch()}
                    disabled={run.isFetching}
                  >
                    Refresh
                  </Button>
                  {selected.ownerId === viewerId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDraft(structuredClone(selected));
                        setError("");
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        ...structuredClone(selected),
                        id: undefined,
                        revision: undefined,
                        visibility: "private",
                        name: selected.name + " copy",
                      })
                    }
                  >
                    Duplicate
                  </Button>
                  {selected.kind === "query" && (
                    <Button size="sm" onClick={() => create("view")}>
                      Create view
                    </Button>
                  )}
                  {selected.kind === "view" && (
                    <Button size="sm" onClick={() => create("dashboard")}>
                      Add to new dashboard
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => window.print()}
                  >
                    Print report
                  </Button>
                </div>
              </header>
              {run.isFetching && (
                <p className="metric-library-summary" role="status">
                  Running queries…
                </p>
              )}
              {run.error && <p role="alert">{run.error.message}</p>}
              {run.data && (
                <>
                  <p className="metric-library-summary">
                    Executed {run.data.runAt} · Live query results. Save
                    evidence from Metrics for an immutable record.
                  </p>
                  <div
                    className={
                      selected.kind === "dashboard" ? "metric-dashboard" : ""
                    }
                    data-layout={selected.config.layout}
                  >
                    {run.data.panels.map((p) => (
                      <section key={p.id}>
                        {p.data ? (
                          <MetricChart data={p.data} options={p.chart} />
                        ) : (
                          <div className="metric-chart">
                            <strong>{p.name}</strong>
                            <p role="alert">{p.error}</p>
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                </>
              )}
              {selected.ownerId === viewerId && (
                <details className="mt-5 metric-studio-actions">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Manage saved item
                  </summary>
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={async () => {
                      setError("");
                      try {
                        await remove.mutateAsync({
                          id: selected.id,
                          revision: selected.revision,
                        });
                        router.push("/metrics?workspace=studio");
                      } catch (e) {
                        setError(
                          e instanceof Error ? e.message : "Unable to delete.",
                        );
                      }
                    }}
                  >
                    Delete saved {selected.kind}
                  </Button>
                </details>
              )}
            </>
          ) : (
            <div className="grid gap-4 py-8">
              <h2 className="text-xl font-semibold">
                Build a view from your questions
              </h2>
              <p className="text-sm text-muted-foreground">
                Save a query from Metrics, combine it with other saved queries,
                then arrange views in a dashboard. Relative periods stay
                current; fixed dates preserve the selected reporting window.
              </p>
              <Link href="/metrics" className="table-link">
                Explore metrics and save your first query →
              </Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
function QueryEditor({
  config,
  onChange,
}: {
  config: SavedQuery;
  onChange: (v: SavedQuery) => void;
}) {
  const detail = useMetricDetail(config.query.metricId,config.query.version),
    metric =
      detail.data?.metric;
  const [now] = useState(() => new Date());
  const bounds =
    config.period === "fixed"
      ? { startsAt: config.query.startsAt, endsAt: config.query.endsAt }
      : metricPeriod(config.period, metric?.timezone ?? "UTC", now);
  const result = useMetricQuery({
    ...config.query,
    ...bounds,
    ...(config.compare
      ? previousMonth(bounds.startsAt, bounds.endsAt, metric?.timezone ?? "UTC")
      : {}),
    metricId: metric ? config.query.metricId : "",
  });
  return (
    <>
      <p className="text-sm">
        {metric?.name ?? "Loading metric…"}
      </p>
      <label className="text-sm">
        Period
        <SelectControl
          value={config.period}
          onValueChange={(period) =>
            onChange({ ...config, period: period as SavedQuery["period"] })
          }
        >
          {periods.map((p) => (
            <option key={p} value={p}>
              {p.replaceAll("_", " ")}
            </option>
          ))}
        </SelectControl>
      </label>
      {config.period === "fixed" && (
        <div className="grid gap-3">
          <label>
            Start (ISO, with timezone)
            <Input
              required
              value={config.query.startsAt}
              onChange={(e) =>
                onChange({
                  ...config,
                  query: { ...config.query, startsAt: e.target.value },
                })
              }
            />
          </label>
          <label>
            Exclusive end (ISO, with timezone)
            <Input
              required
              value={config.query.endsAt}
              onChange={(e) =>
                onChange({
                  ...config,
                  query: { ...config.query, endsAt: e.target.value },
                })
              }
            />
          </label>
        </div>
      )}
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.compare}
          onChange={(e) => onChange({ ...config, compare: e.target.checked })}
        />
        Compare with previous month
      </label>
      {metric && (
        <MetricQueryControls
          hideChart
          metric={metric}
          result={result.data}
          value={{
            ...initialExplorer,
            ...config.query,
            groupMode: config.query.groupMode ?? "auto",
            groupBy: config.query.groupBy ?? [],
            groupSelection: config.query.groupSelection ?? [],
            groupLimit: config.query.groupLimit ?? 5,
            dimensions: config.query.dimensions ?? {},
            aggregation: config.query.aggregation ?? "sum",
            interval: config.query.interval ?? "day",
          }}
          onChange={(v) =>
            onChange({
              ...config,
              query: {
                ...config.query,
                interval: v.interval,
                aggregation:
                  metric.kind === "latest" ? v.aggregation : undefined,
                dimensions: v.dimensions,
                groupBy: v.groupBy,
                groupMode: v.groupMode,
                groupSelection: v.groupSelection,
                groupSearch: v.groupSearch,
                groupLimit: v.groupMode === "top" ? v.groupLimit : 50,
              },
            })
          }
        />
      )}
    </>
  );
}
