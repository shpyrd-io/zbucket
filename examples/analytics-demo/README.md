# Local analytics collection demo

Fictional customer journeys sent by the actual browser SDK to the same-origin relay, then the zbucket HTTP API and PostgreSQL worker. This is a simulation, not customer data or a capacity benchmark.

1. Run `npm run dev` with a local zbucket PostgreSQL database and local access.
2. Run `node --import tsx examples/analytics-demo/server.mjs` in another terminal.
3. Open http://127.0.0.1:4333 and click **Simulate 10 customer journeys** once.
4. Open zbucket at http://127.0.0.1:4332/metrics/events and select the newly created **Demo app** dataset.
5. Run a **People** funnel with `app_opened`, `signup_completed`, `feature_used`, `report_exported`. Expected counts: **10 → 7 → 5 → 3**.
6. Filter the timeline by person `user:person-1` (four events, including the linked anonymous opening) or account `acme-1` (three events after signup).

The server saves verified results to `experiments/metrics/app-demo/data.json` once all 25 events are indexed. Each server start creates a separate integration and dataset source; data remains available for inspection. Credentials and signing keys remain in server memory and are never sent to the browser or saved in the report.

The session endpoint is a deliberately fictional, loopback-only login simulator. Do not deploy it. A real application must supply its authenticated session and rate limiter. This demo limits relay requests to 300/minute and only binds to 127.0.0.1. Reloading and rerunning the page adds another sample; start a new server for a fresh dataset.

## Daily metrics and dashboard

After collecting the 25 events, run `node --import tsx scripts/seed-event-reporting-demo.ts`. It enables the `orbit_daily_events` metric, waits for its history job, and saves an ordered funnel query, metric query, views and the **Orbit · Product analytics** dashboard. Outputs and links are saved in `experiments/metrics/app-demo/reporting.json`.

The same setup is available in the UI: **Process events by day** (optionally include retained history), then **Save funnel query** and the Library's view/dashboard creator. The daily metric counts 25 occurrences; the behavioral funnel counts 10 → 7 → 5 → 3 unique people. These are different questions over the same original events.
