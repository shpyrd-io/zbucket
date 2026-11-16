# Warehouse Python client

Python 3.10+, synchronous, no runtime dependencies. Backend use only. Package name `shpyrd-warehouse`, import `shpyrd_warehouse`. This local package is not published to PyPI.

```sh
python3 -m pip install ./sdk/python
PYTHONPATH=sdk/python/src python3 -m unittest discover -s sdk/python/tests -v
# From the repository root; requires the local PostgreSQL .env:
npm run test:python-sdk
```

## Connection

Use an origin, without `/api/v1`. Set `WAREHOUSE_URL` and `WAREHOUSE_TOKEN` in the consuming backend's secret manager. `WarehouseClient.from_env()` reads these variables; it never executes or loads `.env` files. `WAREHOUSE_ALLOW_INTERNAL_HTTP=1` explicitly permits an internal Kubernetes service origin. HTTPS is required elsewhere except loopback. TLS verification stays enabled and redirects are refused, including login redirects, so a token is never forwarded to another destination.

For this installation, the internal origin is `http://web.p-996iywzafh9ur616c0nj6ykxh.svc.cluster.local`. The caller project also needs Shpyrd network authorization. The public browser hostname requires Shpyrd login and is not a machine API endpoint. For local development, use an authorized loopback-only `kubectl port-forward`; see the sibling `shpyrd-sample-warehouse-feed` project.

```python
from decimal import Decimal
from shpyrd_warehouse import WarehouseClient

client = WarehouseClient.from_env()
registered = client.metrics.register({
    "key": "myapp_sales_brl", "name": "Sales · BRL", "kind": "sum",
    "unit": "BRL", "inputMode": "measurements", "dimensions": ["channel"],
    "status": "active",
})
receipt = client.metrics.measurements([{
    "measurementId": "order-123",  # Stable source ID, preserved on retries.
    "metricKey": "myapp_sales_brl", "observedAt": "2026-10-09T12:00:00-03:00",
    "value": Decimal("125.50"), "unit": "BRL", "dimensions": {"channel": "web"},
    "basis": "observed", "evidence": "Order system",
}])
client.metrics.wait_for_ingestion(receipt["id"])
result = client.metrics.query({
    "metricId": "myapp_sales_brl", "startsAt": "2026-10-09T00:00:00-03:00",
    "endsAt": "2026-10-10T00:00:00-03:00", "interval": "hour", "groupBy": ["channel"],
})
# Decimal strings and null are preserved. Null is not zero.
print(result["value"], result["quality"])
```

Replace timestamps with your real observation/query instants. Registration needs `metrics.manageOwn`. Creation grants the creator read and publish access; it grants nothing on other metrics. Repeating the original registration is safe and does not undo subsequent metadata edits. A changed concept needs a new key. Do not generate a new measurement ID to retry a failed network request.

## API surface

Bodies follow the Warehouse API contract's camelCase field names; Python method options use snake_case. Results retain the server's JSON keys, quality, pagination and provenance.

| Operation | Method |
| --- | --- |
| Catalog | `metrics.catalog(query="", after=None)`, `metrics.iter_metrics(query="")` |
| Definition | `metrics.get(key_or_id)` |
| Register metric + optional event schema | `metrics.register(definition, dataset=None)` |
| Edit metadata | `metrics.update(key_or_id, expected_revision=1, changes={"name":"…"})` |
| Delete unused owned metric | `metrics.delete(key_or_id, expected_revision=1)`; key stays reserved |
| Direct measurements | `metrics.measurements(records, idempotency_key=None)` |
| Events | `metrics.events(dataset_key, records, schema_version=1, idempotency_key=None)` |
| Source aggregates | `metrics.aggregates(records, idempotency_key=None)` |
| Corrections/retractions | `metrics.corrections(body, idempotency_key=None)` |
| Completeness | `metrics.coverage(body)`; only declare actual source coverage |
| Receipt | `metrics.receipt(id)`, `metrics.wait_for_ingestion(id, timeout=120, poll_interval=1)` |
| Query/comparison | `metrics.query(body)` |
| Saved snapshot | `metrics.snapshot(id)` |
| Document catalog | `knowledge.list(collection=None, after=None)`, `knowledge.iter_documents(collection=None)` |
| Hybrid search | `knowledge.search(text, collection=None)` |
| Direct read/history | `knowledge.get(id)`, `knowledge.history(id)` |
| Publish/replace | `knowledge.save(body)` |
| Archive | `knowledge.archive(id, revision=1, reason="…")` |
| Restore | `knowledge.restore(id, revision=2, restore_revision=1, reason="…")` |

Use `groupAfter` from the returned breakdown for grouped query pagination; preserve all other query fields. Catalog iterators follow `nextCursor`; search returns a bounded ranked set, not an exhaustive iterator. `snapshot:true` requires a separate grant.

## Knowledge

Read by stable identity with `client.knowledge.get_by_key("general", "copy_guidelines")`. Browser links use `/knowledge/{collection}/{key}` with each value URL-encoded, for example `/knowledge/general/copy_guidelines`. UUID-based `get()` and existing links remain supported; edits still use the returned ID and revision.
 example

An administrator must first create the collection and grant this integration read/write, search, history and archive as appropriate. The metrics-only sample credential deliberately has no document permissions.

```python
document = client.knowledge.save({
    "collection": "myapp", "key": "runbooks/feed", "title": "Feed runbook",
    "content": "# Feed\n\nRetry the same observation IDs after a connection failure.",
    "source_type": "runbook", "tags": ["feed"], "reason": "Publish integration runbook",
})
matches = client.knowledge.search("How do I retry the feed?", collection="myapp")
archived = client.knowledge.archive(document["id"], revision=document["revision"])
# Archived documents disappear immediately from catalog, lexical and semantic search.
# Authorized direct reads by ID/history remain possible; archive is not deletion.
restored = client.knowledge.restore(document["id"], revision=archived["revision"],
                                    restore_revision=document["revision"])
```

A save is full replacement, not partial PATCH: include content and metadata you intend to retain. Changes require the current document revision; conflicts are not automatically overwritten. Indexing is asynchronous; search reports `mode` and an optional fallback `notice`. The SDK does not send data directly to Voyage; the Warehouse worker/search service handles embeddings under its configuration.

## Reliability and limits

- Monetary values should be decimal strings or `Decimal`, never float. Decimal values serialize as exact strings. Aware `datetime` values serialize with timezone; naive timestamps are rejected. Integers remain integers for revisions/count parameters.
- Each ingestion call accepts 1–1,000 records and up to 5 MiB. Batch explicitly and persist stable record IDs; the client does not generate them or silently split a transaction.
- Registration, ID-stable ingestion and safe reads retry connection failures and HTTP 429/502/503/504 up to twice by default, using the exact payload. `Retry-After` is honored; delays above 60 seconds are returned for the caller to schedule. Configure `max_retries=0` for a job scheduler.
- Metadata changes, document mutations, corrections, coverage, deletion and snapshot-producing queries are not automatically retried. Read the returned error/current revision and reconcile intentionally. A transport failure can mean the request committed but its response was lost.
- `WarehouseError.status` and `.retry_after` expose API failures. `WarehouseTransportError` identifies connection/format failures. `IngestionFailed.receipt` contains the failed receipt. Timeout while polling is not cancellation; retain the receipt and poll it again.
- Constructor `timeout` is a per-attempt network timeout (default 30s). Receipt polling has a separate bounded polling budget. Responses are capped at 32 MiB; narrow or paginate larger queries. No background polling, threads, scheduling, async client or administrative credential-management API is included.

The source of truth for payloads remains [Metrics API](../../docs/metrics-api.md) and [Knowledge API](../../docs/knowledge-api.md).

### Event history

`client.metrics.event_timeline(query)` and `client.metrics.event_funnel(query)` use the same backend token and require explicit `metrics.eventRead` dataset grants. Publish through the existing `client.metrics.events(...)` method; exploration-enabled datasets also require `metrics.eventWrite`. See `docs/metrics-api.md` for mappings, retention, pagination, and funnel semantics.
