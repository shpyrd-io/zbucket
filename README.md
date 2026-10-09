# Warehouse

Shared **Metrics** and **Knowledge** for applications. Every consuming backend uses one integration identity with explicit read/write permissions.

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

**Dependencies:** `.npmrc` sets `install-links=true` to install the bundled design system as the local package recorded in the lockfile. Use `npm ci`; there are no runtime references to the Tower checkout.

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

## API guides

The indexed `docs/` directory contains three application-facing guides:

- [Integration and credentials](docs/integrations.md)
- [Metrics API specification and recipes](docs/metrics-api.md)
- [Knowledge API specification and recipes](docs/knowledge-api.md)

`src/client/warehouse.ts` is a small server-side client. Internal operating instructions live in `ops/` and are not imported into Knowledge. The bundled importer archives only the explicitly retired documentation keys in `scripts/retired-knowledge.json`; it never removes arbitrary documents missing from a directory.

```sh
npm run knowledge:import -- --dir=/absolute/docs/path --dry-run
npm run knowledge:import -- --dir=/absolute/docs/path
npm run lint
npm run typecheck
npm test
npm run test:acceptance
npm run test:api-docs
npm run metrics:verify-resolution
npm run metrics:verify-missing-data
npm run metrics:verify-purge
npm run build
```

Tests use synthetic data and isolated PostgreSQL schemas. `experiments/` contains test reports. See [Deployment](ops/deployment.md) for the authenticated Shpyrd deployment, dedicated database, worker, shared export storage and integration routing. No Tower data migration is performed.
