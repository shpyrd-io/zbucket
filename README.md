# Warehouse

Standalone proof of concept for shared **Metrics** and **Knowledge**, derived from the Control Tower data modules. Every consuming backend uses one integration identity with explicit read/write permissions. Control Tower itself is a future client; the original project is unchanged.

## Run locally

Requires Node.js 24 and PostgreSQL with pgvector.

```sh
npm ci
cp .env.example .env
# Set DATABASE_URL to a dedicated Warehouse database.
npm run db:migrate
npm run knowledge:import
npm run seed:demo
npm run dev
```

Open http://localhost:4332. `dev` starts web and worker together. The local database created for this experiment is `shpyrd_warehouse`; the configured environment is ignored by Git. Voyage is enabled in this local experiment with explicit user authorization. Fresh installations must configure `VOYAGE_API_KEY` to enable semantic indexing/search; see the documented data sent to Voyage. The key stays in the ignored local environment file.

**Dependency note:** the initial machine setup reused an independent copy of Tower's installed dependencies because the registry/cache could not resolve every version in its existing lockfile. The package manifests and lockfile are included; a clean registry install must be rechecked in the deployment environment before release. There are no runtime references to the Tower checkout.

## Explore

- **Metrics:** define a metric, explore dimensions and comparisons, choose charts, save queries/views and compose dashboards.
- **Metric cleanup (administrators):** select a metric → Administration → Purge data. Preview a period and/or exact dimension filter, then confirm. Aggregates and audit history are updated together.
- **Knowledge:** search, browse collections, write Markdown and restore revisions. `/` focuses search; Enter releases focus; J/K selects records.
- **Integrations:** permissions, collections, expiring credentials, revocation/rotation and API activity. Hold Alt to reveal navigation hints; `g m`, `g k`, `g i` navigate.

The optional demo seeds three metrics, seven days of hourly bank balances, 90 days of sales/campaign observations, and a dashboard. Its demo integrations have no credentials until an administrator issues one.

## Chart gallery

Run `npm run seed:charts` in local mode, then open **Metrics → Library → Chart gallery · Fictional company**. The command prints the direct dashboard URL. It adds 11 dedicated `gallery_*` metrics, 14 reusable saved queries and 32 examples covering all 31 supported chart types, numbered for visual review (including vertical and horizontal funnels at 28 and 28b). Data covers the two calendar months preceding the first seed: the dashboard shows the second month, with the first available for comparisons.

The examples include sales by channel/region, bank snapshots, campaign spend/leads/orders, individual request durations, service state, team scores, a sales funnel and signed profit contributions. Everything is synthetic. The gallery integration has no credential. Rerunning keeps the same IDs and deduplicates observations; it updates only the gallery's own saved queries/views/dashboard. Existing metrics and documents remain intact.

Use **Jump to chart** to find an example (the horizontal funnel is **28b** and spans the dashboard width), or hide the library to give the dashboard more room. The visualization selector offers **Funnel · vertical** and **Funnel · horizontal** directly. Hover a time chart to see values in its legend; focus it and use arrows/Home/End, or Escape to return to latest. Legends toggle visibility, **Data** shows exact values, and **Query details** preserves quality and provenance. On roomy cards, legends move beside the plot; narrow cards place them below. Dashboard layouts support up to 32 views while retaining the 20-distinct-query execution budget.

## APIs and architecture

See [Integration guide](docs/integrations.md) for POST payloads, authentication, scoped queries and document publication. [Architecture](docs/architecture.md) records what was extracted, future Tower adoption and PoC limits. These files are also imported into Warehouse's own Knowledge Base. `src/client/warehouse.ts` is a small server-side client; `examples/control-tower-client.ts` illustrates a future consumer.

```sh
npm run knowledge:import -- --dir=/absolute/docs/path --dry-run
npm run knowledge:import -- --dir=/absolute/docs/path
npm run lint
npm run typecheck
npm test
npm run test:acceptance
npm run metrics:verify-resolution
npm run metrics:verify-missing-data
npm run metrics:verify-purge
npm run build
```

Tests use synthetic data and isolated PostgreSQL schemas. `experiments/` contains test reports. No production/staging deployment or Tower data migration is included.
