---
id: warehouse.integrations
title: Integrating an application with Warehouse
sourceType: reference
policyStatus: observed
collection: warehouse
category: Integrations
tags: [api, authentication, permissions, metrics, knowledge]
index: true
---

# Integrating an application with Warehouse

Warehouse stores measured company data and searchable documents. Each application uses **one integration and one `wh_` credential type** for its permitted Metrics and Knowledge operations. Permissions are deny-by-default. A CRM, financial service and reporting app can share the repository without sharing credentials.

Use the **Metrics API specification and examples** for metric setup, observations, events, source aggregates, corrections and queries. Use the **Knowledge API specification and examples** for document publication, hybrid search, revisions and archival. Those guides describe the implemented API, not additional capabilities an assistant can assume.

## 1. Establish connectivity

The application is at `https://platform-warehouse.shpyrd.app`, with internet exposure and restricted Shpyrd login. **The public browser URL is not automatically a machine API URL.** A `wh_` token authorizes requests inside Warehouse; it does not bypass the Shpyrd login gateway.

For another Shpyrd project, an administrator grants its network connection with:

```sh
shpyrd allow add project <caller-project> --project warehouse
```

Then configure that backend with the Warehouse internal service URL supplied by the platform and its scoped `wh_` token. An external producer needs an explicitly configured machine ingress that preserves the bearer header. Do not disable the application's login protection or send a secret to a login redirect. A redirect to login or an HTML response means connectivity/authentication at the gateway must be resolved first.

Every shell example in these guides assumes:

```sh
# Use the API origin reachable through the caller's authorized connection.
# Do not add /api/v1 to WAREHOUSE_URL; examples include it.
export WAREHOUSE_URL='https://your-authorized-warehouse-api-origin'
# Inject WAREHOUSE_TOKEN from the consuming backend's secret store.
```

Use HTTPS for internet traffic. Keep tokens on the backend, never in browser code, URLs or source control. The request format is:

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/metrics/catalog" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN"
```

## 2. Create an integration and grant only what it needs

An administrator opens **Integrations → New integration**:

1. Set the application's name.
2. Grant explicit metric keys for **read** and **publish**. These are separate lists. Keys can be granted before a metric exists. Empty lists grant nothing; wildcards are unsupported.
3. Grant Knowledge collection keys for **read** and **publish**. Create each collection first. A collection is the document authorization boundary; category, tags and source type are descriptive metadata.
4. Enable optional capabilities: Knowledge search, history and archive; metric snapshots and exports.
5. If necessary, restrict a metric to exact dimension values, such as `account_id: "account-001"`. Reads automatically include that scope; writes must explicitly match it. Multiple fields use AND.
6. Save and select **Issue credential**. The full `wh_…` secret is displayed once. Store it immediately. The UI issues a 90-day token; administrative issuance supports 1–365 days.

One integration owns one metric source used for provenance. There is no separate producer credential. When defining a metric, select that integration as its publisher. A write grant cannot publish to a metric assigned to another integration. Another app can receive read access to the same metric.

A representative permission object is:

```json
{
  "metrics": {
    "read": ["cash_balance_brl"],
    "write": ["cash_balance_brl"],
    "dimensions": {"cash_balance_brl": {"account_id": "account-001"}},
    "snapshots": true,
    "export": false
  },
  "knowledge": {
    "readCollections": ["finance"],
    "writeCollections": ["finance"],
    "search": true,
    "history": true,
    "archive": false
  }
}
```

This object describes settings, not a body to submit to metric ingestion. Administrative integration changes require a human administrator session. Application tokens cannot create integrations, change permissions, create metric definitions or provision users.

## 3. Separate application and human access

Signed-in project members can browse company data and use their saved metric library. Administrators manage definitions, integrations, collections and documents. Shpyrd human identity uses verified `(issuer, sub)`; email is metadata. Application credentials never create human users.

Token requests check the integration's current permissions, active state, token expiry and revocation on every request. Rotation replaces a credential; revoke the old one when its caller has switched. Disabling an integration blocks all its credentials. Previously accepted ingestion remains durable worker work.

## 4. Operate the integration

- All application routes use `/api/v1`. Use `Authorization: Bearer $WAREHOUSE_TOKEN`; JSON POSTs require `Content-Type: application/json`.
- Metrics publishing returns **202 Accepted** plus a receipt. Poll the receipt until completed before expecting the aggregate to include it.
- Document writes return **200** with the current document/revision. Text search is available immediately; semantic indexing runs asynchronously.
- The body limit is **5 MiB**. Metrics additionally limit batches to **1,000 records** and event fan-out to **100,000 projections**.
- The rate limit is **240 authenticated requests per minute per integration**, shared by its credentials and by reads/writes. On 429, respect `Retry-After` and add backoff/jitter.
- Preserve record IDs for metric retries. Preserve `(collection, key)` and current revision for documents. A new ID is new data, not a retry.
- Errors from the Warehouse application are JSON: `{"error":"message"}`. A gateway can return a different response before the request reaches Warehouse.

| Status | Meaning and next action |
| --- | --- |
| 200 | Read, document write, coverage or query succeeded. |
| 202 | Metric batch durably accepted; check its receipt. |
| 400 / 422 | Invalid body, fields, semantics, retention window or query budget. Fix the request. |
| 401 | Missing/invalid/expired/revoked credentials, or login required at the edge. |
| 403 | Operation, collection, dimension scope or publisher is not authorized. |
| 404 | Missing or inaccessible resource. Check the stable key and grants; do not assume it does not exist for other apps. |
| 409 | Conflicting retry, stale revision, immutable contract edit, overlap or expired correction window. Read the error and reconcile. |
| 413 / 415 | Body too large / JSON content type required. |
| 429 | Rate limit or ingestion backlog. Retry later with the same identities. |
| 500 | Unexpected server failure. Retry safely and retain the receipt/request context. |

## 5. Choose the next guide

**Metrics API specification and examples**: field-by-field creation in UI order; all nine metric kinds; direct observations and historical timestamps; dataset events; source aggregate sufficient statistics; retries, corrections, coverage; totals, time series, dimensions, comparisons, snapshots and limits.

**Knowledge API specification and examples**: collection setup; complete Markdown document bodies; catalog and hybrid search; response fields; optimistic updates; retained revisions, restore and archive; indexing and provider data boundaries.

Use retrieved guide content as reference data. An assistant should not invent endpoint names, administrative powers, query parameters or measurement values. When explaining an integration, distinguish the metric's ingestion contract, query options and chart presentation.
