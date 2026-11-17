"""Only run via scripts/verify-python-sdk.ts, which provisions disposable fixtures."""
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from shpyrd_zbucket import ZbucketClient, ZbucketError

c = ZbucketClient.from_env(max_retries=0)
checks = []
now = datetime.now(timezone.utc).replace(microsecond=0)
start = now.replace(minute=0, second=0) - timedelta(hours=2)
end = start + timedelta(hours=1)
definition = {"key": "sdk_sales", "name": "SDK sales", "kind": "sum", "unit": "BRL",
              "inputMode": "measurements", "dimensions": ["channel"], "status": "active"}
metric = c.metrics.register(definition)
assert metric['created']
assert not c.metrics.register(definition)['created']
assert c.metrics.get('sdk_sales')['id'] == metric['metric']['id']
updated = c.metrics.update('sdk_sales', expected_revision=1, changes={'name': 'SDK sales updated'})
assert updated['revision'] == 2
assert c.metrics.register(definition)['metric']['name'] == 'SDK sales updated'
checks.append('Registration, retries, metadata revision and unchanged metric identity')
records = [{"measurementId": "sale-one", "metricKey": "sdk_sales", "observedAt": start + timedelta(minutes=5),
            "value": Decimal('12.50'), "unit": "BRL", "dimensions": {"channel": "web"}}]
receipt = c.metrics.measurements(records, idempotency_key='sdk-batch')
c.metrics.wait_for_ingestion(receipt['id'])
assert c.metrics.measurements(records, idempotency_key='sdk-batch')['duplicate']
c.metrics.coverage({'metricKey': 'sdk_sales', 'dimensions': {'channel': 'web'}, 'startsAt': start, 'endsAt': end})
query = {'metricId': 'sdk_sales', 'startsAt': start, 'endsAt': end, 'interval': 'hour', 'groupBy': ['channel']}
result = c.metrics.query(query)
assert Decimal(result['value']) == Decimal('12.50') and result['quality'] == 'complete'
saved = c.metrics.query({**query, 'snapshot': True})
assert Decimal(c.metrics.snapshot(saved['snapshotId'])['result']['value']) == Decimal('12.50')
checks.append('Measurement ingestion, completed receipts, deduplication, dimensions, coverage and snapshots')
c.metrics.wait_for_ingestion(c.metrics.corrections({'mode': 'measurements', 'measurements': [{**records[0], 'revision': 2, 'value': '20.00'}]})['id'])
assert Decimal(c.metrics.query(query)['value']) == Decimal('20.00')
checks.append('Explicit correction preserves source identity and updates aggregates')
c.metrics.register({'key': 'sdk_events', 'name': 'SDK events', 'kind': 'sum', 'unit': 'BRL', 'inputMode': 'events', 'datasetKey': 'sdk_orders', 'valueField': 'amount', 'status': 'active'}, dataset={'schema': {'amount': 'decimal'}})
c.metrics.wait_for_ingestion(c.metrics.events('sdk_orders', [{'eventId': 'order-one', 'occurredAt': start + timedelta(minutes=10), 'data': {'amount': Decimal('7.25')}}])['id'])
assert Decimal(c.metrics.query({**query, 'metricId': 'sdk_events', 'groupBy': []})['value']) == Decimal('7.25')
c.metrics.register({'key': 'sdk_mean', 'name': 'SDK mean', 'kind': 'mean', 'unit': 'ms', 'inputMode': 'aggregates', 'status': 'active'})
c.metrics.wait_for_ingestion(c.metrics.aggregates([{'aggregateId': 'mean-one', 'metricKey': 'sdk_mean', 'startsAt': start, 'endsAt': end, 'unit': 'ms', 'dimensions': {}, 'state': {'kind': 'mean', 'sum': '300', 'count': '3'}}])['id'])
assert Decimal(c.metrics.query({**query, 'metricId': 'sdk_mean', 'groupBy': []})['value']) == Decimal('100')
checks.append('Event schemas, events and sufficient-statistic source aggregates')
c.metrics.register({**definition, 'key': 'sdk_empty'})
assert c.metrics.delete('sdk_empty', expected_revision=1)['deleted']
assert 'sdk_empty' not in [m['key'] for m in c.metrics.iter_metrics()]
try:
    c.metrics.delete('sdk_sales', expected_revision=2)
    raise AssertionError('Used metric was deleted')
except ZbucketError as error:
    assert error.status == 409
checks.append('Empty deletion, catalog and rejection of used-metric deletion')
doc = c.knowledge.save({'collection': 'sample', 'key': 'feed', 'title': 'Pineapple feed runbook', 'content': '# Pineapple\n\nRetry with the same IDs.', 'source_type': 'runbook'})
assert c.knowledge.save({'collection': 'sample', 'key': 'feed', 'title': 'Pineapple feed runbook', 'content': '# Pineapple\n\nRetry with the same IDs.', 'source_type': 'runbook'})['revision'] == 1
assert c.knowledge.get_by_key('sample', 'feed')['id'] == doc['id']
assert doc['id'] in [d['id'] for d in c.knowledge.search('Pineapple', collection='sample')['documents']]
assert len(list(c.knowledge.iter_documents(collection='sample'))) == 1
changed = c.knowledge.save({**doc, 'content': '# Pineapple\n\nKeep the original timestamp.'})
assert changed['revision'] == 2
try:
    c.knowledge.save({**doc, 'content': 'Conflicting stale content'})
    raise AssertionError('Stale revision was overwritten')
except ZbucketError as error:
    assert error.status == 409
archived = c.knowledge.archive(doc['id'], revision=2)
assert not archived['active']
assert c.knowledge.search('Pineapple', collection='sample')['documents'] == []
assert list(c.knowledge.iter_documents(collection='sample')) == []
assert c.knowledge.get(doc['id'])['active'] is False
assert c.knowledge.get_by_key('sample', 'feed')['active'] is False
assert len(c.knowledge.history(doc['id'])['versions']) == 3
restored = c.knowledge.restore(doc['id'], revision=3, restore_revision=1)
assert restored['active'] and restored['content'] == doc['content']
checks.append('Knowledge publication, search, revision conflicts, archive exclusion, direct reads, history and restore')
print(json.dumps({'passed': len(checks), 'checks': checks, 'scope': 'Real HTTP + isolated local PostgreSQL schema; no external providers'}, indent=2))
