---
id: warehouse.integrations
title: Integrating an application with Warehouse
sourceType: reference
policyStatus: observed
collection: warehouse
category: Integrations
tags: [api, credentials, metrics, knowledge]
index: true
---

# Integrating an application with Warehouse

Warehouse is a separate data repository for Metrics and Knowledge. Control Tower is a potential client, just like a CRM, financial system or reporting app. No Tower database is shared or modified by this PoC.

## One integration, one credential type

1. Open **Integrations → New integration**. Choose the application's name.
2. Enter explicit metric keys it may **read** and **publish**. Empty lists grant no access. Wildcards are not supported. Keys may be granted before the metric exists.
3. Enter Knowledge collection keys it may read and publish. Collections must exist first. Categories, tags and source types organize documents; **collections are the authorization boundary**.
4. Enable search, document history/archive, query snapshots and exports only when needed. Optional metric dimension scopes apply to both reads and writes. Reads automatically include the scope; writes must explicitly match it.
5. Save, then **Issue credential**. Store the `wh_…` secret in the consuming backend. It is shown once and stored as a hash. UI-issued credentials expire after 90 days; API issuance permits 1–365 days. Rotate or revoke it here.

An integration automatically receives one metric source for provenance. There is no second producer token. Disabling the integration denies all token requests. Every token checks current permissions, expiration and revocation. Already accepted ingestion remains durable work for the worker.

Personal sessions and application tokens are distinct. Tokens never create human users or manage integrations. In Shpyrd mode, human identity is `(issuer, sub)`; email is metadata. Only signed-in administrators manage integrations and data definitions. Other signed-in members may browse company data and save their own metric library items.

## Publish observations

Create the metric in **Metrics → Add metric**, choosing this **Integration** as its authoritative publisher. A write grant alone does not authorize publishing to a metric assigned to a different integration.

```sh
curl "$WAREHOUSE_URL/api/v1/metrics/measurements" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"measurements":[{"measurementId":"bank-a-20261008T130000Z","metricKey":"cash_balance_brl","observedAt":"2026-10-08T10:00:00-03:00","value":"125000.50","unit":"BRL","dimensions":{"account_id":"account-001"},"basis":"observed","evidence":"Bank API snapshot"}]}'
```

The response is HTTP 202 with an ingestion `id`, `accepted` and `duplicates`. Accepted means durably queued, not yet visible in aggregates. Poll `GET /api/v1/metrics/ingestions/{id}` using the same token. It can see only its own integration's receipts. `measurementId` is stable within the integration. Repeating an unchanged record does not double count it. Use decimal strings. `definitionVersion` is unnecessary.

For movement/event streams, administrators register a typed dataset in **Integrations → Event datasets and identifiers**. Send `POST /metrics/events` with `datasetKey`, `schemaVersion` and `events:[{eventId, occurredAt, data}]`. All matching metric projections must be authorized, otherwise the entire request is rejected. Source aggregates use `POST /metrics/aggregates`. Corrections use `POST /metrics/corrections` with the original mode and the next record revision. Coverage declarations use `POST /metrics/coverage`. These paths are relative to `/api/v1`.

Batch JSON requests are limited to 5 MiB and the metric engine's batch/projection budgets. Send large histories in bounded batches, with stable record IDs and retry backoff. The application quota is 240 requests per minute; HTTP 429 includes Retry-After. Raw retention and correction limits remain part of the metric contract.

## Administrator-only metric cleanup

Open **Metrics → select a metric → Administration → Purge data…**. Select a start-inclusive/end-exclusive period, exact dimension values, or both. For example, `account_id = account-001` with no period removes that account's retained data from this metric. Multiple dimension fields use AND. Blank fields include all values. The UI displays which timezone is used for date entry. The immutable metric definition is unchanged.

**Preview cleanup** displays raw measurements, record identities, pending revisions, affected aggregate buckets, coverage intervals and dimension combinations. These are separate counts, not a summed number of observations. Review the scope, supply a reason and type the metric's exact key before confirming. **Activity → Cleanup details** records the administrator, reason, filters and counts.

These two endpoints require a human administrator session; a `wh_` integration credential can never access them, even with metric write permission:

```http
POST /api/v1/metrics/purge-preview/cash_balance_brl
Content-Type: application/json

{
  "startsAt": "2026-10-08T00:00:00-03:00",
  "endsAt": "2026-10-09T00:00:00-03:00",
  "dimensions": {"account_id": "account-001"}
}
```

Dates can both be omitted when at least one dimension value is supplied. The response includes normalized `scope`, `counts` and `fingerprint`. To execute, POST to `/api/v1/metrics/purge/cash_balance_brl` with those same scope fields plus `fingerprint`, `confirmationKey: "cash_balance_brl"` and a nonempty `reason`. A changed preview returns 409; obtain and review a fresh preview instead of retrying the destructive request blindly. Pending corrections must finish first. A request without any scope is rejected.

Purged observations are removed from live queries and affected aggregates are rebuilt or removed atomically. Old retries remain duplicates. A correction cannot republish a purged record into that metric; deliberate replacement data must have **new record IDs** and still satisfy retention rules. This is cleanup, not a permanent ban on future observations in that period or dimension. Already-published snapshots and export files remain historical records. Source events shared with other metrics can retain their original payload for those metrics.

If raw history has expired, a partial aggregate bucket cannot be safely rebuilt: choose complete reporting days (respecting the metric's timezone) or an all-time dimension filter. Source interval aggregates must be selected whole. With **Keep previous value**, an older surviving observation may still carry into a purged period; no replacement observation is fabricated. Database failures roll back the purge. Busy metrics return 409; execution limits return 422 with guidance to narrow the scope.

## Query the same repository

```sh
curl "$WAREHOUSE_URL/api/v1/metrics/query" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metricId":"cash_balance_brl","startsAt":"2026-10-01T00:00:00Z","endsAt":"2026-11-01T00:00:00Z","interval":"hour","aggregation":"sum","groupBy":["account_id"],"groupLimit":50}'
```

`metricId` accepts the stable key or internal ID. End dates are exclusive. Omit `groupBy` for a combined result; set `dimensions:{"account_id":"account-001"}` for one account. The reducer works across dimension tuples; a snapshot selects each tuple's last eligible observation first. Inspect quality and observation age as well as the value.

Use `GET /metrics/catalog?q=…&after=…` to discover permitted metrics; `GET /metrics/definition/{key}` reads the contract. Query responses include totals, series, optional grouped results/cursors and optional comparison periods. Use `compareStartsAt` and `compareEndsAt` for a comparison. Never calculate exact measurements from separate narrative signals.

`POST /metrics/query` with `snapshot:true` requires snapshot permission and saves an immutable result. `GET /metrics/snapshots/{id}` revalidates the integration and its current dimension scope. `POST /metrics/export-query` downloads the same scoped query as JSON and requires export permission. Interactive raw NDJSON export is for human sessions; machine raw exports and arbitrary library/dashboard execution are intentionally not exposed by this PoC.

## Publish and search Knowledge

```sh
curl "$WAREHOUSE_URL/api/v1/knowledge/documents" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"general","key":"crm/onboarding","title":"Customer onboarding","content":"# Onboarding\n\nVerify the account before activation.","category":"CRM","tags":["customers"],"source_type":"runbook"}'

curl -G "$WAREHOUSE_URL/api/v1/knowledge/documents" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  --data-urlencode 'q=customer activation' \
  --data-urlencode 'collection=general'
```

A document is identified by `(collection, key)`. An unchanged repeat is idempotent. A changed document requires its current `revision`; stale edits return 409. Integrations may edit only documents they own inside permitted collections. Administrators can edit all documents. To update send `id`, `revision`, `title`, `content` and metadata. To archive add `action:"archive"`; to restore use `action:"restore", restoreRevision:N`, also supplying the current revision.

Read `GET /knowledge/documents/{id}` and `/knowledge/documents/{id}/history`. Keep the current revision and 20 previous revisions. Search excludes archived documents and applies collection permissions before retrieval. Text search is immediately available; with Voyage configured, the worker indexes current chunks and search combines text and semantic matches. A semantic failure explicitly falls back to text. Only document title/body chunks and search queries are sent to Voyage; no application tokens, other tables or provider credentials are included. A removed scope also removes access to older revisions.

## Future Control Tower adoption

Use the server-side client in `src/client/warehouse.ts`; never expose a `wh_` token to browser JavaScript. The Tower backend could ingest measurements, query results and retrieve allowed documents over HTTP. Its decisions, signals, people and investigations remain in Tower. Store Warehouse snapshot IDs and document revision references as evidence.

Before adopting this architecture: test latency and availability between apps, independently back up Warehouse, rehearse data migration, configure least-privilege integrations, and choose the cutover strategy. Do not dual-write indefinitely or silently fall back to an out-of-date local copy. This PoC does not switch the existing Tower to Warehouse.
