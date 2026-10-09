---
id: warehouse.architecture
title: Warehouse architecture and PoC boundaries
sourceType: reference
policyStatus: observed
collection: warehouse
category: Architecture
tags: [architecture, deployment]
index: true
---

# Warehouse architecture

Warehouse is a standalone Next.js application, PostgreSQL database with pgvector, and background worker. The original Control Tower remains independent. There are no runtime file imports, symlinks or database links to Tower.

## Kept from Control Tower

- Decimal-safe metric ingestion and immutable definitions; event, measurement and aggregate modes.
- Retry identity, corrections, raw facts, incremental base/hour/day states and retention.
- Dimension filters, grouped series, comparisons, snapshots, visual exploration and a saved query/view/dashboard library.
- The bundled Shpyrd design system and data workspace layout, with independent column scrolling.

Metric core code was copied from Tower's working tree on October 9, 2026, including the immutable-contract changes. It is a source snapshot, not yet a shared package. Future extraction into a versioned data engine could reduce maintenance divergence once the PoC proves useful.

## Extracted and simplified

Knowledge has collection-scoped APIs, Markdown rendering/editing, document history, directory import and optional Voyage hybrid search. It does not index Tower operational tables. Integration administration and personal identity have their own small schema. A single integration maps to a single metric source and one `wh_` credential type.

No agent harness, OpenRouter model, company strategy, DRI assignment, problem management, incident workflow or signal triage is part of this application. Metric thresholds that generate Tower Signals are not carried over. Dashboards and charts remain data presentation features.

## Processes and isolation

`npm run dev` starts the web UI at 127.0.0.1:4332 and a worker. `npm run worker` runs background ingestion, raw export, retention and optional knowledge indexing separately. `npm run build` and `npm start` are the production web commands. Keep the worker running whenever ingestion is enabled. The Metrics UI refresh is manual.

Use an independent `DATABASE_URL`; never reuse the Tower database. The example DB is `shpyrd_warehouse`. Local files for exports live under this project's `.data`. Back up PostgreSQL and any pending file jobs together. There is no automated deployment in this PoC.

Local identity is restricted to development and loopback. Production fails closed unless Shpyrd issuer, project and workspace are configured. Personal JWTs are verified against JWKS, issuer, project audience, workspace, expiration and allowed provider. App credentials bypass personal provisioning and are verified only by Warehouse. Configure the hosting gateway to pass machine Authorization headers to `/api/v1/metrics/*` and `/api/v1/knowledge/*`; the application still enforces permissions. Do not make the whole app public to solve a gateway redirect.

## Deliberate boundaries

One installation represents one company/workspace. Apps share that repository through explicit grants. This is not a multi-tenant SaaS boundary. Human project members have company-wide read access; only project administrators change metric contracts, documents and integration permissions. Per-human collection ACLs are a future addition if needed.

Application writes are bounded synchronous acceptance followed by asynchronous aggregation. Machine APIs do not expose arbitrary SQL, administrative metric definition creation, bulk file import or raw NDJSON exports in this PoC. High-volume integrations should batch JSON and poll their receipts. The existing metrics query limits remain in force; the system does not promise unlimited throughput.

Voyage is optional; configure its credential only with explicit authorization. Text search remains functional without it. Changing the embedding model requires reindexing; vectors from another model are excluded from query results. Indexing uses current document revisions and retries failed jobs a bounded number of times. Administrators can queue a reindex using `POST /api/v1/knowledge/reindex`.

## Metric purge consistency

Metric cleanup is available only to human administrators, through a read-only preview followed by exact-key confirmation and an audit reason. It filters observation time and exact dimension values. The execution transaction recalculates the preview fingerprint under the same source advisory, source row and metric locks used to exclude ingestion, worker publication and retention. Coverage writes also take the source lock. A changed scope result requires another preview; pending corrections must publish before cleanup.

The transaction deletes selected raw facts, removes this metric's projections from their record journal, and deletes complete selected buckets. Partially selected base/hour/day buckets and legacy hourly states are rebuilt from remaining raw sufficient statistics. Raw-retention watermarks prevent rebuilding incomplete history. Coverage is split around the period, and unused dimension tuples are removed so snapshot queries do not expect deleted series. Cleanup does not edit the immutable metric contract or other event fanout projections.

`metric_purges` retains actor, reason, scope and counts. `metric_purged_records` and original idempotency hashes prevent old retries or corrections from restoring removed values. Source payloads are removed when no metric projection needs them; shared payloads may remain for another metric. Saved query snapshots, previous export files and backups are not rewritten: this feature is operational measurement cleanup, not a comprehensive erasure request. Live saved queries and dashboards see the updated data on their next execution.

Purge uses SQL set operations and database-side fingerprints rather than loading observations into application memory. Each statement has a 60-second execution limit and lock acquisition a 5-second limit; any failure rolls back all changes. Source publication may pause during this administrative operation. Narrow the scope if it exceeds these limits. Large installations may eventually need partition-level cleanup jobs; the PoC intentionally keeps execution atomic.

`npm run metrics:verify-purge` verifies scoped cleanup, rollup rebuilding, queued publication, corrections, shared events, retry safety, retention/DST boundaries, API permissions, rollback and a 20,000-observation/1,000-series fixture in an isolated schema. Timings and coverage are recorded in `experiments/metrics/purge-report.json`.
