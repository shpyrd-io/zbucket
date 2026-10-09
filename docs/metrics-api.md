---
id: warehouse.metrics-api
title: Metrics API specification and examples
sourceType: reference
policyStatus: observed
collection: warehouse
category: API specifications
tags: [api, metrics, ingestion, aggregation, dimensions, examples, balances]
index: true
---

# Metrics API specification and examples

Use this guide to define, publish and query measurements. All examples are fictional. They assume an authorized API origin in `WAREHOUSE_URL` and a scoped `wh_` credential in `WAREHOUSE_TOKEN`; see **Integrating an application with Warehouse** for gateway access and permissions. A Shpyrd browser login and a Warehouse application token are different credentials.

## Three independent decisions

1. **Ingestion contract:** what one observation means, its unit, dimensions, authoritative publisher/input mode and metric kind. This contract is immutable after creation.
2. **Query:** period, interval, dimension filters, grouping and (for `latest` snapshots) the reducer across dimension tuples.
3. **Presentation:** line, bars, area, number, pie, table or another supported chart. A chart does not change measurement meaning or manufacture missing data. The API returns typed query data; the consumer chooses its chart.

A raw record is not necessarily a transaction. A bank balance observation contains an amount, an account and an observation time. It is not a bank statement line item. Never sum hourly balance readings to compute a daily balance: select each account's latest eligible reading and then combine accounts.

## Endpoint map for application credentials

All paths below are relative to `/api/v1`.

| Method and path | Required grant | Body or result |
| --- | --- | --- |
| GET `/metrics/catalog?q=…&after=…` | Metric read keys | `{metrics, nextCursor?}`; 50 per page for integrations, ordered by stable key. Search matches name/key. Pass the returned cursor unchanged. |
| GET `/metrics/definition/{key-or-id}` | Read on metric | `{metric}` containing the current contract and settings. |
| POST `/metrics/measurements` | Write + configured publisher | `{measurements:[…]}` → 202 receipt. |
| POST `/metrics/events` | Write on every resulting projection + configured publisher | `{datasetKey,schemaVersion,events:[…]}` → 202 receipt. |
| POST `/metrics/aggregates` | Write + configured publisher | `{aggregates:[…]}` → 202 receipt. |
| POST `/metrics/corrections` | Write on old and new projections | `{mode,…}` replacement batch or tombstone → 202 receipt. |
| GET `/metrics/ingestions/{id}` | Same integration that submitted the batch | `{id,status,recordCount,error,createdAt}`. |
| POST `/metrics/coverage` | Write + configured publisher | One metric/dimension tuple and a fully received interval → `{ok:true}`. |
| POST `/metrics/query` | Read; snapshots grant when requested | `MetricQuery` → total, time series, optional groups/comparison/snapshot. |
| POST `/metrics/export-query` | Read + export; snapshots if requested | Same query body; JSON download of the query result. |
| GET `/metrics/snapshots/{id}` | Snapshot grant + current read/scope | Saved integration-owned snapshot row with `query` and `result`. |

No PUT/PATCH/DELETE methods are implemented for these interfaces. Raw NDJSON exports, raw detail, distributions, saved library execution, definitions, datasets and purge are human-session interfaces; a `wh_` token cannot invoke them. Machine clients can build reports from the authorized query data.

## Create a metric: actual form order

An administrator first creates the integration, grants the metric key and then opens **Metrics → Add metric**. Read the fields in the following order when guiding someone through the form (paired rows are left-to-right). Dataset/field mappings and filters are used by `events`; direct measurements use fixed envelope names.

| Order / form label | Contract field | Hourly bank-balance example |
| --- | --- | --- |
| 1. Name | `name` | `Cash balance · BRL` |
| 2. Stable key | `key` | `cash_balance_brl` |
| 3. Description | `description` | `Point-in-time bank account balances observed hourly. BRL only.` |
| 4. Aggregation | `kind` | `latest` |
| 5. Unit | `unit` | `BRL` |
| 6. Integration | `sourceId` | Choose the financial application's integration. Internally this is its source UUID, not its integration UUID or token. |
| 7. Input | `inputMode` | `measurements` |
| 8. Category | `category` | `Finance` |
| 9. Timezone | `timezone` | `America/Sao_Paulo` |
| 10. Dimensions (comma separated) | `dimensions` | `account_id` |
| 11. Dataset key | `datasetKey` | Leave `observations` for this measurement input. |
| 12. Value field | `valueField` | Leave `value`; measurement envelopes always use `value`. |
| 13. Filters (JSON) | `filters` | `{}` |
| 14. Numerator field | `numeratorField` | Leave `numerator`; unused for this kind. |
| 15. Denominator field | `denominatorField` | Leave `denominator`; unused for this kind. |
| 16. Identity field | `identityField` | Leave `identity`; unused for this kind. |
| 17. Freshness (seconds) | `freshnessSeconds` | `7200`, if the business considers a reading stale after two hours. Valid range: 60–31,536,000. |
| 18. Maximum series | `maxSeries` | `10000`, sized for distinct dimension combinations. Valid range: 1–100,000. |
| 19. Favorable direction | `direction` | `neutral`, or `higher` if appropriate for this business definition. It does not change arithmetic. |
| 20. Missing data (latest only) | `missingData` | `keep_previous` to retain the last known balance, marked stale beyond freshness. |
| 21. Storage and resolution | `storagePolicy` | Enable; base `hour`, hourly retention 90 days, daily retention 730 days, raw retention blank to retain raw detail. |
| 22. Status | `status` | `active` before sending data. Draft, paused and retired metrics reject new observations. |

Within **Storage and resolution**, the order is: enable policy, Base resolution, retention fields (Base when finer than hour, Hourly when applicable, Daily), Raw retention, Estimated active series. The last field is only a UI capacity estimate; it does not set the metric's series budget. An hourly base has equal base/hour retention. A daily base has equal base/hour/day retention.

This is the equivalent **administrator-only** definition body, useful as a reference for setup; application credentials cannot submit it. Replace `SOURCE_ID` with the integration's source UUID. The route is `POST /api/v1/metrics/definitions` with a human administrator session, not the publishing curl token.

<!-- example: balance-definition -->
```json
{
  "definition": {
    "key": "cash_balance_brl",
    "name": "Cash balance · BRL",
    "description": "Point-in-time bank account balances observed hourly. BRL only.",
    "kind": "latest",
    "unit": "BRL",
    "sourceId": "SOURCE_ID",
    "inputMode": "measurements",
    "datasetKey": "observations",
    "dimensions": ["account_id"],
    "timezone": "America/Sao_Paulo",
    "freshnessSeconds": 7200,
    "maxSeries": 10000,
    "missingData": "keep_previous",
    "storagePolicy": {
      "baseResolution": "hour",
      "baseRetentionDays": 90,
      "hourRetentionDays": 90,
      "dayRetentionDays": 730,
      "rawRetentionDays": null
    },
    "status": "active",
    "direction": "neutral"
  }
}
```

For a new concept, currency, reducer, publisher, dimensions or resolution/retention contract, use a new metric key. Ordinary edits to name, description, category, status, direction and series budget keep existing data. Missing-data reporting policy is edited separately. Producers should use the stable metric key and **omit `definitionVersion`**; it is legacy compatibility, not a version to select for normal ingestion or reporting. No currency conversion is implicit.

## Choose a kind and input mode

| Kind | Meaning | Suitable examples | Observation payload fields |
| --- | --- | --- | --- |
| `sum` | Add contributions over time and groups. | Revenue, cost, ad spend, units, impressions supplied as nonoverlapping increments. | `value` decimal string |
| `count` | One count per raw observation/event. | Orders, deployments, signups. | No value required; every record contributes 1. |
| `latest` | Last eligible observation per full dimension tuple at each exclusive boundary. | Account balance, inventory, queue depth, service state. | `value` decimal string |
| `mean` | Arithmetic mean of observations, or weighted merge of source sum/count. | Request duration, ticket resolution duration. | `value` decimal string |
| `ratio` | Sum of numerators / sum of denominators. | Conversion rate, uptime, CPC, CPA, change failure rate. | `numerator`, `denominator` decimal strings |
| `min` | Minimum observation in the requested scope. | Lowest temperature, minimum stock reading. | `value` decimal string |
| `max` | Maximum observation in the requested scope. | Peak queue depth, largest order. | `value` decimal string |
| `distinct` | Exact distinct identity count over the scope. | Unique visitors/customers. | `identity` string |
| `p95` | 95th percentile of individual numeric samples. | Request or deployment duration. | `value` decimal string |

`measurements` directly names a metric. `events` projects a registered dataset into one or more metrics. `aggregates` accepts **sufficient statistics for complete, nonoverlapping source intervals**; it cannot accept `latest`, scalar distinct counts or scalar percentiles. Never average already-computed averages or add per-group unique counts to get a global unique count. Exact distinct identities must be stable across groups for deduplication to mean the same thing.

Cumulative counters must be transformed into reset-aware increments by the producer before using `sum`; Warehouse does not implement Prometheus-style counter reset/rate semantics. Cohorts, arbitrary formulas and joins across unrelated metrics are not implicit metric kinds. For CPC/CPA, provide spend and clicks/acquisitions together to a `ratio` metric if you want the correctly weighted result.

## Shared publishing conventions

Save each JSON example below into a file and POST it to the specified route. For example, save the balance batch as `measurements.json`:

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/metrics/measurements" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @measurements.json
```

- Decimal quantities are **strings**, such as `"125000.50"`, with at most 24 integer and 12 fractional digits. Do not send JSON numbers, commas or scientific notation as measurement values. Timestamps require ISO date/time plus `Z` or numeric offset.
- Supply exactly all declared dimensions, each a nonempty string of at most 200 characters. No extra/missing dimensions and no simultaneous totals plus subtotals. At most 8 dimensions can be declared. `maxSeries` counts combinations, not the number of fields: 1,000 campaigns × 3 regions may create 3,000 series.
- `unit` must exactly match the definition for measurements/aggregates. Event values inherit each projection's unit; the dataset producer must guarantee that semantic convention.
- `measurementId`, `eventId` and `aggregateId` are stable record identities within the publishing integration's source, **shared across input modes and metric keys**. Prefix IDs by dataset/metric to avoid collisions. Maximum length is 200 characters.
- Send 1–1,000 records and at most 5 MiB per request. Do not generate a new record ID when retrying. The optional `Idempotency-Key` header (up to 200 characters) replays a whole batch only if its payload is unchanged.
- Omit record `revision` initially (defaults to 1). Supply the next consecutive revision only through corrections.
- `basis` and `evidence` can retain provenance in the original submitted payload. They do not change aggregation or validate whether the observation is true. The producer is responsible for them; manual UI measurements require evidence.
- `observedAt`/`occurredAt` is when the fact occurred; receipt time is recorded separately. Historical backfill uses the original observation time, in bounded batches. Once raw retention has advanced past that time, backfill/corrections can be rejected; an old timestamp does not restore expired detail.

## Recipe 1: hourly account balances (`latest`)

Use the definition above. At exactly 10:00 local time two accounts are observed:

<!-- example: balances -->
```json
{
  "measurements": [
    {
      "measurementId": "cash_balance_brl-account-001-20261008T130000Z",
      "metricKey": "cash_balance_brl",
      "observedAt": "2026-10-08T10:00:00-03:00",
      "value": "125000.50",
      "unit": "BRL",
      "dimensions": {"account_id": "account-001"},
      "basis": "observed",
      "evidence": "Bank API balance snapshot"
    },
    {
      "measurementId": "cash_balance_brl-account-002-20261008T130000Z",
      "metricKey": "cash_balance_brl",
      "observedAt": "2026-10-08T10:00:00-03:00",
      "value": "74999.50",
      "unit": "BRL",
      "dimensions": {"account_id": "account-002"},
      "basis": "observed",
      "evidence": "Bank API balance snapshot"
    }
  ]
}
```

These are **readings at 10:00**, not values retroactively assigned to 09:00–10:00. Query boundaries are start-inclusive/end-exclusive. The 10:00 reading contributes to the 10:00–11:00 interval and is eligible at its 11:00 boundary; it is excluded from a query ending exactly at 10:00. Do not subtract a millisecond to force it into the previous hour. If the source actually reports a closed interval, define that semantic explicitly before integration.

For `latest`, the returned summary is the state at the query's end, not a sum of its hourly points. At a boundary Warehouse first selects each full dimension tuple's last eligible observation, then applies the query's cross-series `sum`, `mean`, `min` or `max`.

**Keep previous value** uses the last known eligible observation, possibly from before the query start if still retained, without creating fake observations. After `freshnessSeconds` it remains visible with `stale` quality and its observation timestamp. It never fills an earlier hour with a later reading. A tuple with no known prior value stays missing. **Leave gaps** suppresses an aggregate when required known tuples lack fresh values. Neither policy silently replaces unavailable balances with zero. Expected tuples come from known dimension sets, not a separate external bank-account registry.

## Recipe 2: direct revenue, order counts, durations and peaks

Create these active metrics with input `measurements`, timezone `UTC` and the indicated dimension. For these four metrics an hourly policy with 90-day base/hour and 730-day daily retention is suitable; raw retention depends on correction needs. Grant each key to the same publisher.

| Metric key | Kind | Unit | Dimensions | Value meaning |
| --- | --- | --- | --- | --- |
| `sales_revenue_brl` | `sum` | `BRL` | `channel` | One order's revenue, never the cumulative daily revenue. |
| `orders_received` | `count` | `orders` | `channel` | One submitted observation = one order. |
| `request_duration_ms` | `mean` | `ms` | `service` | One completed request duration. |
| `queue_peak` | `max` | `jobs` | `service` | One queue depth sample; the query selects the maximum. |

POST `/api/v1/metrics/measurements`:

<!-- example: direct-kinds -->
```json
{
  "measurements": [
    {"measurementId":"sales-order-101","metricKey":"sales_revenue_brl","observedAt":"2026-10-08T13:00:00Z","value":"350.00","unit":"BRL","dimensions":{"channel":"web"}},
    {"measurementId":"order-count-101","metricKey":"orders_received","observedAt":"2026-10-08T13:00:00Z","unit":"orders","dimensions":{"channel":"web"}},
    {"measurementId":"duration-req-1","metricKey":"request_duration_ms","observedAt":"2026-10-08T13:00:00Z","value":"100.00","unit":"ms","dimensions":{"service":"checkout"}},
    {"measurementId":"duration-req-2","metricKey":"request_duration_ms","observedAt":"2026-10-08T13:01:00Z","value":"300.00","unit":"ms","dimensions":{"service":"checkout"}},
    {"measurementId":"queue-sample-1","metricKey":"queue_peak","observedAt":"2026-10-08T13:00:00Z","value":"12","unit":"jobs","dimensions":{"service":"checkout"}},
    {"measurementId":"queue-sample-2","metricKey":"queue_peak","observedAt":"2026-10-08T13:01:00Z","value":"19","unit":"jobs","dimensions":{"service":"checkout"}}
  ]
}
```

Over this scope the mean duration is 200 ms and peak queue depth is 19 jobs. Sending `value:"500"` to a `count` observation would still contribute one count; use a `count` source aggregate to publish a pre-counted batch, or a `sum` metric for explicit count increments.

## Recipe 3: ratios for conversion, uptime and cost per click

Create `campaign_conversion_rate` (`ratio`, unit `ratio`, dimension `campaign_id`), `service_uptime` (`ratio`, unit `ratio`, dimension `service`) and `campaign_cpc_brl` (`ratio`, unit `BRL/click`, dimension `campaign_id`) with input `measurements`. These point records describe contributions assigned to their observation time. For a whole hourly interval with a fixed allocation use source aggregates instead.

POST `/api/v1/metrics/measurements`:

<!-- example: ratios -->
```json
{
  "measurements": [
    {"measurementId":"conversion-c1-b1","metricKey":"campaign_conversion_rate","observedAt":"2026-10-08T13:00:00Z","numerator":"5","denominator":"100","unit":"ratio","dimensions":{"campaign_id":"campaign-001"}},
    {"measurementId":"conversion-c2-b1","metricKey":"campaign_conversion_rate","observedAt":"2026-10-08T13:00:00Z","numerator":"30","denominator":"1000","unit":"ratio","dimensions":{"campaign_id":"campaign-002"}},
    {"measurementId":"uptime-checkout-1","metricKey":"service_uptime","observedAt":"2026-10-08T13:00:00Z","numerator":"3540","denominator":"3600","unit":"ratio","dimensions":{"service":"checkout"}},
    {"measurementId":"cpc-c1-b1","metricKey":"campaign_cpc_brl","observedAt":"2026-10-08T13:00:00Z","numerator":"250.00","denominator":"100","unit":"BRL/click","dimensions":{"campaign_id":"campaign-001"}}
  ]
}
```

Across both campaigns conversion is `35 / 1100 ≈ 0.03181818` (3.18%), **not** the average of 5% and 3%. Uptime is `3540 / 3600 ≈ 0.98333333`; CPC is 2.50 BRL/click. Store rate ratios in 0–1 units when that is the chosen convention; display percentages in the consumer. A zero summed denominator yields `null`, not infinity or zero. A denominator must be nonnegative; whether a particular numerator is valid for the business is the producer's responsibility.

DORA examples follow the same primitives: deployment frequency is `count`; change failure rate is `ratio` (failed deployments / total deployments); lead time and recovery duration are individual duration samples with `mean` or `p95`. A time-weighted average balance is not the same as an arithmetic mean of irregular samples and is not implicitly calculated here.

## Recipe 4: minimum, exact unique visitors and p95

Create `room_temperature_min` (`min`, `C`, dimension `room`), `unique_visitors` (`distinct`, `visitors`, dimension `campaign_id`) and `request_duration_p95_ms` (`p95`, `ms`, dimension `service`), input `measurements`. **Do not enable a resolution policy for distinct or p95**: they require raw detail. Percentiles use numerical interpolation in the database, not fixed-decimal financial arithmetic.

POST `/api/v1/metrics/measurements`:

<!-- example: raw-kinds -->
```json
{
  "measurements": [
    {"measurementId":"temperature-1","metricKey":"room_temperature_min","observedAt":"2026-10-08T13:00:00Z","value":"22.5","unit":"C","dimensions":{"room":"stock"}},
    {"measurementId":"temperature-2","metricKey":"room_temperature_min","observedAt":"2026-10-08T13:01:00Z","value":"21.5","unit":"C","dimensions":{"room":"stock"}},
    {"measurementId":"visit-1","metricKey":"unique_visitors","observedAt":"2026-10-08T13:00:00Z","identity":"visitor-a","unit":"visitors","dimensions":{"campaign_id":"campaign-001"}},
    {"measurementId":"visit-2","metricKey":"unique_visitors","observedAt":"2026-10-08T13:01:00Z","identity":"visitor-a","unit":"visitors","dimensions":{"campaign_id":"campaign-002"}},
    {"measurementId":"visit-3","metricKey":"unique_visitors","observedAt":"2026-10-08T13:02:00Z","identity":"visitor-b","unit":"visitors","dimensions":{"campaign_id":"campaign-002"}},
    {"measurementId":"latency-1","metricKey":"request_duration_p95_ms","observedAt":"2026-10-08T13:00:00Z","value":"100","unit":"ms","dimensions":{"service":"checkout"}},
    {"measurementId":"latency-2","metricKey":"request_duration_p95_ms","observedAt":"2026-10-08T13:01:00Z","value":"200","unit":"ms","dimensions":{"service":"checkout"}},
    {"measurementId":"latency-3","metricKey":"request_duration_p95_ms","observedAt":"2026-10-08T13:02:00Z","value":"500","unit":"ms","dimensions":{"service":"checkout"}}
  ]
}
```

The global distinct count is 2 even though summing the two campaign distinct counts gives 3. The minimum is 21.5 C and the interpolated p95 of these three samples is 470 ms. Retain raw samples and observe query budgets; a daily p95 value cannot be merged into an exact monthly p95.

## Recipe 5: one event dataset, several metrics

An administrator registers a schema in **Integrations → Event datasets and identifiers**. All declared fields are required and undeclared fields are rejected. Supported field types are `string`, `decimal`, `datetime`.

Equivalent admin-only `POST /api/v1/metrics/datasets` body:

<!-- example: order-dataset -->
```json
{
  "sourceId": "SOURCE_ID",
  "key": "completed_orders",
  "version": 1,
  "schema": {"amount_brl":"decimal","channel":"string","customer_id":"string","state":"string"}
}
```

Create the following active metrics from the **same integration**, all with `inputMode: "events"`, `datasetKey: "completed_orders"`, timezone `UTC`, dimensions `["channel"]`, filters `{"state":"completed"}`:

| Key | Kind | Unit | Field mapping |
| --- | --- | --- | --- |
| `event_revenue_brl` | `sum` | `BRL` | `valueField: "amount_brl"` |
| `event_orders` | `count` | `orders` | No numeric field used. |
| `event_buyers` | `distinct` | `customers` | `identityField: "customer_id"`; no storage policy. |

The publisher needs write access to every resulting projection. A denied projection rejects the batch atomically; it is not silently skipped. An event matching no filters can be accepted with no metric contribution, so check filter values when debugging empty results.

Save as `events.json`, then send:

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/metrics/events" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @events.json
```

<!-- example: order-events -->
```json
{
  "datasetKey": "completed_orders",
  "schemaVersion": 1,
  "events": [
    {"eventId":"completed-orders-201","occurredAt":"2026-10-08T13:00:00Z","data":{"amount_brl":"100.00","channel":"web","customer_id":"customer-a","state":"completed"}},
    {"eventId":"completed-orders-202","occurredAt":"2026-10-08T13:01:00Z","data":{"amount_brl":"250.00","channel":"web","customer_id":"customer-a","state":"completed"}}
  ]
}
```

This produces 350 BRL, two orders and one unique customer for the example scope. Do not also submit these same orders directly to another input mode of the same metric: each metric has one authoritative input mode. To compute a distinct metric from the same facts, define it as another projection of the dataset.

## Recipe 6: pre-aggregated hourly data

Use `inputMode: "aggregates"` and a base resolution of `hour`. Each contribution covers exactly one aligned base bucket; intervals are `[startsAt, endsAt)`, with the metric's reporting timezone defining alignment. Intervals for the same metric and complete dimension tuple cannot overlap. You cannot subdivide a supplied hourly aggregate into minute-level results, nor split it with an arbitrary query boundary.

Create these active metrics, timezone `UTC`, dimensions `["campaign_id"]`: `ad_spend_brl` (`sum`, `BRL`), `ad_impressions` (`count`, `impressions`), `ad_duration_mean_ms` (`mean`, `ms`), `ad_ctr` (`ratio`, `ratio`), `ad_bid_min_brl` (`min`, `BRL`) and `ad_bid_max_brl` (`max`, `BRL`). For each, configure hourly base/hour retention 90 days, daily retention 730 days, raw retention appropriate for correction needs.

Save as `aggregates.json` and POST with the same headers to `/api/v1/metrics/aggregates`:

<!-- example: source-aggregates -->
```json
{
  "aggregates": [
    {"aggregateId":"spend-c1-20261008T13","metricKey":"ad_spend_brl","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"BRL","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"sum","sum":"120.00"}},
    {"aggregateId":"impressions-c1-20261008T13","metricKey":"ad_impressions","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"impressions","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"count","count":"10000"}},
    {"aggregateId":"duration-c1-20261008T13","metricKey":"ad_duration_mean_ms","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"ms","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"mean","sum":"3000","count":"10"}},
    {"aggregateId":"ctr-c1-20261008T13","metricKey":"ad_ctr","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"ratio","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"ratio","numerator":"125","denominator":"10000"}},
    {"aggregateId":"bid-min-c1-20261008T13","metricKey":"ad_bid_min_brl","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"BRL","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"min","value":"0.40"}},
    {"aggregateId":"bid-max-c1-20261008T13","metricKey":"ad_bid_max_brl","startsAt":"2026-10-08T13:00:00Z","endsAt":"2026-10-08T14:00:00Z","unit":"BRL","dimensions":{"campaign_id":"campaign-001"},"state":{"kind":"max","value":"2.10"}}
  ]
}
```

The mean state must include **sum and count**, not `average:300`. Ratio states carry numerator/denominator, not a pre-rounded percentage. The mean count must be a positive integer; the count metric accepts nonnegative integer totals, including zero. The `state.kind` must match the definition. Source aggregates reject latest snapshots, scalar p95 and scalar distinct counts; choose measurements/events for those.

A daily source feed needs base `day` and complete local-day boundaries. It cannot provide a genuine hourly chart. Choose retention and minimum resolution at definition time based on desired drill-down and data volume.

## Acceptance, retries and corrections

A first batch normally returns:

```json
{"id":"INGESTION_ID","status":"accepted","accepted":2,"duplicates":0}
```

Poll:

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/metrics/ingestions/$INGESTION_ID" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN"
```

Proceed when `status` is `completed`. An all-duplicate batch may be completed immediately. Whole-batch idempotency replay can return `{id,status,duplicate:true}` instead of accepted/duplicate counts. A receipt reports submitted unique records; it is not the sum of their business values. Inspect the receipt's `error` and escalate a failed batch rather than creating new record IDs blindly. Only the submitting integration can read its receipts.

An unchanged same-ID/same-revision record is deduplicated. Changed content with the same identity/revision returns 409. To replace a value, use `POST /api/v1/metrics/corrections`, the original mode, the same record ID and **next** revision. Supply the complete replacement record, not a delta. For an event correction also include dataset key/schema version and the full required data object.

<!-- example: balance-correction -->
```json
{
  "mode": "measurements",
  "measurements": [
    {
      "measurementId": "cash_balance_brl-account-001-20261008T130000Z",
      "revision": 2,
      "metricKey": "cash_balance_brl",
      "observedAt": "2026-10-08T10:00:00-03:00",
      "value": "126000.50",
      "unit": "BRL",
      "dimensions": {"account_id": "account-001"},
      "basis": "observed",
      "evidence": "Bank corrected the original snapshot"
    }
  ]
}
```

To retract that corrected record, send this to the same corrections route. It is a real removal from live results, so only use it intentionally:

<!-- example: balance-retraction -->
```json
{
  "mode": "measurements",
  "recordId": "cash_balance_brl-account-001-20261008T130000Z",
  "revision": 3,
  "tombstone": true,
  "reason": "The bank invalidated this observation"
}
```

Corrections/retractions authorize old and new scopes, rebuild affected states and cannot recover detail after its raw-retention watermark. Earlier saved query snapshots are historical records; they are not rewritten. A purge performed by an administrator also prevents old record identities/corrections from restoring the removed metric data. Application tokens cannot run purge.

## Coverage is a completeness statement, not another value

After a producer knows every contribution in an interval has arrived and published, it can POST `/api/v1/metrics/coverage` for each full dimension tuple. Do not declare coverage just to hide missing data. Coverage neither inserts a zero nor invents observations.

<!-- example: sales-coverage -->
```json
{
  "metricKey": "sales_revenue_brl",
  "dimensions": {"channel": "web"},
  "startsAt": "2026-10-08T13:00:00Z",
  "endsAt": "2026-10-08T14:00:00Z"
}
```

For nonsnapshot totals, coverage helps distinguish partial from complete intervals. Snapshot freshness is evaluated using actual observation times. Coverage does not make an old balance fresh and does not define an external population of expected accounts.

## Query contract

Send JSON to `POST /api/v1/metrics/query` with the publishing headers (a read-only integration token is also sufficient). Use actual dates for the desired reporting period; symbolic `mtd`, `last_month` and natural-language dates are **not** accepted by this API. A client resolves MTD to the first local instant of the month through its chosen exclusive end, and last month to two local month boundaries, with correct timezone offsets.

| Field | Rules |
| --- | --- |
| `metricId` | Required stable key or internal metric UUID. |
| `startsAt`, `endsAt` | Required ISO instants with timezone; end exclusive and later than start; at most 732 days per query. |
| `interval` | `minute`, `5_minutes`, `15_minutes`, `hour`, `day`, `week`, `month`. Always supply it for predictable series behavior. It cannot be finer than retained base resolution. |
| `dimensions` | Optional exact string-value filter; declared dimensions only. Multiple filters use AND. Omitted filters include the permitted scope. |
| `aggregation` | For `latest` only: `sum`, `mean`, `min`, `max` across the selected full dimension tuples at each boundary. Required if any dimension is not fully filtered. Other kinds use the metric's defined reducer; omit this field. |
| `groupBy` | Zero to three distinct declared dimension names. Separates results; does not change the overall permitted total. |
| `groupLimit`, `groupAfter` | Page size 1–100 (default 50), opaque cursor from `breakdown.nextCursor`. Keep period, filters and grouping identical while paging. |
| `groupMode` | Optional `auto`, `selected`, `top`. Omit for normal paginated group enumeration. Auto shows combined series when 10 or more groups exist. |
| `groupSelection` | For selected mode: up to 10 exact objects containing every groupBy key. |
| `groupSearch` | Optional group text search, up to 200 characters; filters group choices, not the overall metric total. |
| `groupRemainder` | Optional remainder where supported: one grouping dimension and additive sum/count or latest-with-sum. An Other row is marked `other:true`. |
| `compareStartsAt`, `compareEndsAt` | Supply both to compare another period using the same query semantics. |
| `snapshot` | Optional boolean; requires snapshot grant. Saves the result and returns `snapshotId`. |

Top mode chooses up to 10 groups by descending summary value (limited by groupLimit); it is not a replacement for enumerating every group. Filters narrow the metric total; choosing which groups to draw does not. A query is one metric; a custom dashboard can combine several query results after aligning units, calendar boundaries and intervals.

### Total balance by hour, across all permitted accounts

<!-- example: balance-query -->
```json
{
  "metricId": "cash_balance_brl",
  "startsAt": "2026-10-08T10:00:00-03:00",
  "endsAt": "2026-10-08T12:00:00-03:00",
  "interval": "hour",
  "aggregation": "sum"
}
```

For the initial example, the total is 200,000 BRL while both readings remain eligible. `series` contains the time buckets; top-level `value` is the balance at the exclusive end boundary. These are not successive additions of 200,000 BRL.

### One account by hour

<!-- example: account-query -->
```json
{
  "metricId": "cash_balance_brl",
  "startsAt": "2026-10-08T10:00:00-03:00",
  "endsAt": "2026-10-08T12:00:00-03:00",
  "interval": "hour",
  "dimensions": {"account_id": "account-001"}
}
```

### Average latest balance across accounts

Use the total-balance body and change `aggregation` to `"mean"`. With the original two readings the mean is 100,000 BRL. This is the average across accounts **at each boundary**, not the average balance over time. Use `groupBy:["account_id"]` plus `aggregation:"sum"` to receive individual account series and the combined total in one response.

### Daily closing balance

<!-- example: daily-balance-query -->
```json
{
  "metricId": "cash_balance_brl",
  "startsAt": "2026-10-08T00:00:00-03:00",
  "endsAt": "2026-10-09T00:00:00-03:00",
  "interval": "day",
  "aggregation": "sum",
  "groupBy": ["account_id"]
}
```

This selects the last eligible observation strictly before midnight for each account. With keep-previous, an earlier reading may remain in the result marked stale. A new reading exactly at midnight belongs to the next day. Inspect the timestamps/quality before describing a carried reading as a fresh daily close.

### Campaign impressions: all campaigns, grouped, filtered or compared

<!-- example: campaign-query -->
```json
{
  "metricId": "ad_impressions",
  "startsAt": "2026-10-08T13:00:00Z",
  "endsAt": "2026-10-08T14:00:00Z",
  "interval": "hour",
  "groupBy": ["campaign_id"],
  "groupLimit": 50,
  "compareStartsAt": "2026-10-07T13:00:00Z",
  "compareEndsAt": "2026-10-07T14:00:00Z"
}
```

Omit `groupBy` for the combined series; add `dimensions:{"campaign_id":"campaign-001"}` for one campaign. Do not send `aggregation:"sum"` for count/sum metrics; their reducer is already defined. On grouped queries `groups` carries per-group time series and `breakdown.rows` carries period summary values. Totals include all allowed groups, even on later pages. Comparison grouping has its own breakdown/cursor; match groups by dimension keys and times by the intended relative calendar alignment, never by array position alone.

### Result shape and data quality

A response contains the metric definition; `value`, `count`, `numerator`, `denominator`; normalized `startsAt`/`endsAt`; `quality`, `reason` when applicable; `generation`, `lastReceivedAt`, `coverageEndsAt`; and `series:[{startsAt,value,count,quality,…}]`. Resolution queries also return `interval`, `aggregation`, `resolution`; grouped queries add `groups`, `breakdown`, and display metadata. Optional comparisons contain `value`, `absolute`, `relative`, quality, boundaries and series/groups. Relative change is a percentage (e.g. `"10"` means +10%) and is null when the previous value is not positive or either result is unavailable.

Values are decimal strings or null; keep exact strings for exports and use a decimal library for financial calculations. `count` describes engine observations/contributions, not necessarily the business count: for `ad_impressions`, read `value`, not `count`, for the impression total. Bucket timestamps are ISO instants; format labels in the metric's timezone. Respect `groupComplete`, pagination and any Other group before presenting a subset as a total.

| Quality | Interpretation |
| --- | --- |
| `complete` | Coverage or snapshot freshness requirements are satisfied for this query. |
| `partial` | A value exists but complete source coverage is not declared. |
| `missing` | No eligible value, missing required snapshot tuple, or undefined ratio. Null is not zero. |
| `stale` | A retained snapshot is older than its freshness threshold. |
| `recomputing` | Accepted revisions are still pending publication. Refresh after receipt completion. |

Snapshot metadata includes `observedAt`, `oldestObservedAt`, `knownCount`, `expectedCount`, `staleCount` where available. The latest received time is ingestion time, not necessarily the observation time. A step chart is appropriate for carried snapshots; a chart must not relabel stale values as newly observed.

### Save evidence or export

Add `"snapshot":true` to a successful query body to preserve its value, definition, quality, comparison and boundaries. GET `/metrics/snapshots/{snapshotId}` returns an integration-owned record whose `result` is the saved query response. Current read and dimension permissions are checked again. A live query/chart changes on refresh; a saved snapshot does not.

POST the same query body to `/metrics/export-query` for a JSON attachment. This is a bounded query export, not a bulk raw-data stream. Do not implement a CSV export by converting decimal strings through floating point.

## Resolution, retention and operational limits

- Base resolutions: minute, 5 minutes, 15 minutes, hour, day. Queries can use coarser intervals, including week/month. Closed daily states support long history after fine-grained states expire. No second-level base or automatic recovery of expired hourly detail is supported.
- Retention must increase from base to hour to day, each 1–36,500 days; finite raw retention cannot exceed base retention. `null` raw retention retains detail, with corresponding storage growth. Storage policy is part of the immutable contract.
- Query a maximum of 732 days, 10,000 time points, 100,000 grouped points; snapshot series × (time buckets + summary) must fit 100,000. Raw scans are bounded to 100,000 rows and retained-state scans to 1,000,000 rows. These are request budgets, not total database capacity.
- One thousand campaigns can be supported within a suitable series budget. Use dimension filters, pagination and coarser periods when needed; do not request 1,000 account snapshots × every hour of two years in one interactive query.
- Inputs with source intervals must be wholly selected and base-aligned. If raw detail expired, arbitrary partial bucket boundaries may fail; choose retained aligned boundaries.
- Backlog admission is bounded to 100,000 unprocessed source records. A 429 requires waiting for the worker, not parallelizing more retries.
- The Metrics screen refreshes manually. Check ingestion receipts and use Refresh after publishing; a 202 response does not imply that the existing chart has already reloaded.

When helping someone, start with their concrete fact (movement, snapshot, sample, ratio or source aggregate), unit, dimensions and timing. Then walk the actual creation form in order, show one authenticated POST and one query, and only introduce advanced options that matter for that use case.
