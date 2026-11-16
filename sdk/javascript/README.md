# Warehouse JavaScript SDK

Browser collection and a Node first-party relay over the existing Metrics Events pipeline. No public Warehouse credential, separate event store, Redis, or external queue is required.

## Build and install

From the Warehouse checkout:

```sh
npm run build:sdk
npm pack ./sdk/javascript
```

Install the resulting tarball in your application. The package is not published to npm. The generated static script is also available at `/sdk/warehouse-0.1.0.js` on your Warehouse host. Self-host that versioned asset on the application origin if preferred. Never put `wh_` tokens or signing secrets in `NEXT_PUBLIC_*` variables.

## Register a dataset once

An administrator registers a new dataset/schema version through `POST /api/v1/metrics/datasets`:

```json
{
  "sourceId": "INTEGRATION_SOURCE_ID",
  "key": "app_behavior",
  "version": 1,
  "schema": {
    "name": "string", "person": "string", "account": "string?",
    "session": "string", "properties": "properties"
  }
}
```

Enable it through `POST /api/v1/metrics/event-datasets`:

```json
{
  "sourceId": "INTEGRATION_SOURCE_ID",
  "datasetKey": "app_behavior", "schemaVersion": 1,
  "mapping": {
    "name": "name", "userId": "person", "accountId": "account",
    "sessionId": "session", "properties": "properties"
  },
  "retentionDays": 90
}
```

The relay entry exports `browserDatasetSchema` and `browserEventMapping` with these values. Grant this integration `metrics.eventWrite: ["app_behavior"]` and, if needed, `metrics.eventRead: ["app_behavior"]`. Metrics projected from this dataset also require their existing metric write grants. Configuration is immutable: register a new schema version instead of changing an existing contract.

## Next.js relay

Implement `app/analytics/events/route.ts` in the consuming application:

```ts
import {WarehouseClient} from '@shpyrd/warehouse-browser/server';
import {createAnalyticsRelay} from '@shpyrd/warehouse-browser/relay';
import {readSession, analyticsRateLimit} from '@/server/auth';

export const runtime = 'nodejs';
export const POST = createAnalyticsRelay({
  origin: process.env.APP_ORIGIN!,
  signingSecret: process.env.ANALYTICS_SIGNING_SECRET!,
  client: new WarehouseClient(
    process.env.WAREHOUSE_URL!, process.env.WAREHOUSE_TOKEN!
  ),
  datasetKey: 'app_behavior',
  schemaVersion: 1,
  allowRequest: analyticsRateLimit,
  resolveIdentity: async request => {
    const session = await readSession(request);
    if (!session) return null;
    return {userId: session.user.id, accountId: session.activeAccount.id};
  },
});
```

`readSession` and `analyticsRateLimit` are application-owned integrations, not SDK functions. Validate active-account membership inside `readSession`. `allowRequest` is mandatory and returns whether this request is admitted; use the application's existing shared per-session/IP limiter and reverse-proxy request limits. Generate a dedicated random secret of at least 32 characters. Persist it across replicas. The relay rejects foreign/missing Origin, limits streamed bodies to 48 KiB, accepts at most 20 events, and fixes dataset/version server-side. It must run in Node, not the Edge runtime.

The relay returns signed identity contexts and an HttpOnly, SameSite=Lax anonymous cookie (Secure on HTTPS). Contexts expire after 24 hours by default, configurable to 60–86400 seconds. Signed contexts are short-lived write capabilities, not proof that a browser action occurred. The relay ignores unsigned user/account fields. Backend business events such as payment confirmation should continue to use the server SDK directly.

## Capture

```ts
import {warehouse} from '@shpyrd/warehouse-browser';

await warehouse.init({
  endpoint: '/analytics/events',
  pageviews: true,
  onError: message => console.warn(message),
});
await warehouse.track('app_opened');
// After the application's login request and session cookie have completed:
await warehouse.identify(currentUser.id);
await warehouse.setAccount(activeAccount.id);
await warehouse.track('feature_used', {feature: 'reports', paid: true});
// After the application's logout has completed:
await warehouse.reset();
```

For a script installation:

```html
<script src="/sdk/warehouse-0.1.0.js"></script>
<script>
  window.warehouse.init({endpoint: '/analytics/events', pageviews: true})
    .catch(console.error);
</script>
```

Copy the generated script into the application's public directory, or use its absolute Warehouse asset URL. The capture endpoint remains on the application origin. It exposes the API without auto-initializing, so the application controls when capture begins. In React, initialize once at the application boundary, handle rejected promises, and call `destroy()` when tearing down that instance. `new WarehouseBrowser()` allows isolated instances; use distinct endpoint paths for separate datasets.

`identify` and `setAccount` refresh and verify the server session; they cannot choose arbitrary identities. Complete login/account switching before calling them. `reset` rotates anonymous identity and session, and requires an unauthenticated server session. The relay also rotates anonymous identity when it detects a different authenticated user. `optOut()` clears pending events and persists the preference in local storage; `optIn()` resumes. When consent is absent, defer `init`; do not call SDK methods before initialization.

## Delivery and identity semantics

- Stable event UUID and occurrence time across retries. Events snapshot properties and signed identity at creation, including the active account.
- Flush every five seconds or at 20 queued events. Batches are capped at 40 KiB; retryable failures use exponential backoff and jitter. `pagehide`/hidden visibility trigger best-effort `fetch(..., keepalive:true)`.
- Up to 200 queued events persisted per tab in sessionStorage, with memory fallback. Sessions expire after 30 minutes of inactivity **per tab**. Tabs do not share session IDs.
- The relay accepts events up to 24 hours old and five minutes in the future. Terminal rejections drop the batch and invoke `onError`; expired contexts are not re-signed to a new account. Retries preserve IDs and Warehouse deduplicates them. Closing a browser or clearing storage can lose events; there is no exactly-once browser delivery guarantee.
- Automatic pageviews capture only pathname, including SPA path changes observed at the flush interval. They exclude query strings, fragments, page titles and form values. Fast intermediate route changes can be missed; use `page()` explicitly for precise router instrumentation and disable automatic pageviews.
- `person` uses `anon:<uuid>` or `user:<application-id>`. Immutable, dataset/version-scoped aliases resolve anonymous history into the identified person's timeline and funnels. Raw originals and original person IDs are preserved. Accounts are never retroactively inferred. Use the same namespaced person IDs in backend events when joining journeys.
- Alias association is available only to authenticated integration writers through `metrics/event-identify`. No anonymous-to-anonymous chains or user-to-user merges are supported. A conflicting association returns 409.
- Properties allow up to 50 named scalar values (string, finite number, boolean, null); nested objects are rejected. Decimal financial values should remain strings and use the existing declared decimal fields for metric calculations.

No replay, arbitrary DOM autocapture, automatic cross-domain identity, public direct-ingestion token, or session sharing across tabs is included.

## Validation

Unit tests cover signed contexts, spoofing, account switches, reset, retries, session expiry, opt-out and property validation. `npm run test:events` adds a PostgreSQL journey through the relay, login association, deduplication, typed property filters, funnel conversion and account timeline isolation.

## Local load benchmark

Run `npm run test:load-events` from the Warehouse repository with its local PostgreSQL configuration. The script refuses non-loopback database hosts, creates an isolated schema, exercises real HTTP requests against the API route handlers and relay, and drops the schema in `finally`. It offers 120,000 events in batches of 1,000 and another 6,000 through the browser relay in batches of 20. Two worker loops run concurrently; timeline reads run during ingestion. It also checks deduplication, reconciles persisted counts, measures 25 queries per read scenario and tests the funnel candidate limit.

Results, environment details and the exact person-timeline EXPLAIN plan including payload lookup are saved to `experiments/metrics/events-load-report.json`. These are local burst measurements, not a sustained production capacity claim. The generator, HTTP harness and workers share one Node process. This does not exercise a real browser, SDK retry scheduling, TLS, Next.js HTTP serving, a production proxy or multiple application replicas. The relay admission callback permits requests to expose the Warehouse integration quota without another limiter masking it.


### Quotas and retry responses

Event publishing and identity linking share a separate per-integration budget of 2,400 requests and 240,000 submitted events per UTC database minute, shared across credentials and replicas. With full 20-event browser batches, the request budget permits at most 48,000 events/minute; this is an admission ceiling, not a throughput guarantee. General operations, including queries, retain their shared 240-request budget. Retries count toward the publishing budgets; a full source backlog still rejects writes. The relay preserves upstream `429` and `Retry-After` for both capture and identity linking. The browser keeps event IDs and delays retries accordingly. `WarehouseHttpError` exposes `status` and `retryAfter` to server consumers.

The load test also forces quota exhaustion after the main traffic, verifies `429` and its delay, simulates window expiry, and retries previously accepted records to verify recovery without duplication. This recovery probe is separate from the burst throughput measurements.
