import { request } from "./request";
import { response } from "./api";
import type { LibraryItem } from "@/models/metrics/library";
import type {
  ChartOptions,
  PlotData,
  Distribution,
} from "@/models/metrics/visualization";
import type { MetricQuery } from "@/models/metrics/types";
export type LibraryRun = {
  runAt: string;
  item: LibraryItem;
  panels: {
    id: string;
    name: string;
    chart: ChartOptions;
    data?: PlotData;
    error?: string;
  }[];
};
const post = (path: string, data: unknown) =>
  request("/api/v1/metrics/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const metricLibraryApi = {
  list: () => request("/api/v1/metrics/library").then(response<LibraryItem[]>),
  save: ({ id, ...data }: Partial<LibraryItem>) =>
    post("library" + (id ? "/" + id : ""), data).then(response<LibraryItem>),
  remove: ({ id, revision }: { id: string; revision: number }) =>
    post("library/" + id, { action: "delete", revision }).then(
      response<{ ok: boolean }>,
    ),
  run: (id: string) => post("library-run", { id }).then(response<LibraryRun>),
  distribution: (q: MetricQuery) =>
    post("distribution", q).then(response<Distribution>),
};
