import json
import threading
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from shpyrd_warehouse import IngestionFailed, WarehouseClient, WarehouseError, WarehouseTransportError

TOKEN = "wh_" + "a" * 43


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append((self.command, self.path, dict(self.headers), body))
        status, headers, payload = self.server.responses.pop(0)
        self.send_response(status)
        self.send_header("Content-Type", headers.pop("Content-Type", "application/json"))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

    do_GET = do_POST = do_PATCH = do_DELETE = handle_request


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.responses = []
        self.server.requests = []
        self.client = WarehouseClient(self.origin, TOKEN, max_retries=1)

    def reply(self, payload, status=200, **headers):
        self.server.responses.append((status, headers, payload))

    def body(self):
        return json.loads(self.server.requests[-1][3])

    def test_behavior_queries_preserve_cursor_and_scope(self):
        query = {"datasetKey": "activity", "schemaVersion": 1, "accountId": "acme",
                 "after": {"occurredAt": "2026-11-14T00:00:00Z", "eventId": "123"}}
        self.reply({"events": [], "nextCursor": None})
        self.client.metrics.event_timeline(query)
        self.assertEqual(self.server.requests[-1][1], "/api/v1/metrics/event-timeline")
        self.assertEqual(self.body(), query)
        self.reply({"steps": [], "participants": []})
        self.client.metrics.event_funnel({"datasetKey": "activity", "unit": "account"})
        self.assertEqual(self.server.requests[-1][1], "/api/v1/metrics/event-funnel")
        self.assertEqual(self.body()["unit"], "account")

    def test_auth_decimal_and_datetime_encoding(self):
        self.reply({"id": "receipt", "status": "accepted"}, 202)
        self.client.metrics.measurements([{"measurementId": "stable", "value": Decimal("9007199254740993.10"),
                                          "observedAt": datetime(2026, 10, 9, tzinfo=timezone.utc)}], idempotency_key="batch-1")
        method, path, headers, _ = self.server.requests[0]
        self.assertEqual((method, path), ("POST", "/api/v1/metrics/measurements"))
        self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
        self.assertEqual(headers["Idempotency-Key"], "batch-1")
        self.assertEqual(self.body()["measurements"][0]["value"], "9007199254740993.10")
        self.assertEqual(self.body()["measurements"][0]["observedAt"], "2026-10-09T00:00:00+00:00")
        self.assertNotIn(TOKEN, repr(self.client))

    def test_reject_float_naive_datetime_and_nonfinite_decimal(self):
        for value in (0.1, datetime(2026, 10, 9), Decimal("NaN"), Decimal("Infinity")):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                self.client.metrics.measurements([{"measurementId": "stable", "value": value}])
        self.assertEqual(self.server.requests, [])

    def test_no_redirect_credential_forwarding(self):
        self.reply({}, 302, Location=self.origin + "/login")
        with self.assertRaises(WarehouseError) as raised:
            self.client.metrics.catalog()
        self.assertEqual(raised.exception.status, 302)
        self.assertEqual(len(self.server.requests), 1)

    def test_html_gateway_response_is_explicit(self):
        self.reply(b"<html>Login</html>", **{"Content-Type": "text/html"})
        with self.assertRaisesRegex(WarehouseTransportError, "gateway"):
            self.client.metrics.catalog()

    def test_origin_policy(self):
        for url in ("http://example.com", "https://user:pass@example.com", "https://example.com/api/v1",
                    "https://example.com?q=1", "https://example.com/#token", "ftp://example.com"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                WarehouseClient(url, TOKEN)
        internal = "http://web.p-example.svc.cluster.local"
        with self.assertRaises(ValueError):
            WarehouseClient(internal, TOKEN)
        self.assertEqual(WarehouseClient(internal, TOKEN, allow_internal_http=True).base_url, internal)
        with self.assertRaises(ValueError):
            WarehouseClient("http://public.example.com", TOKEN, allow_internal_http=True)

    def test_batch_and_request_budgets(self):
        for records in ([], [{}], [{"measurementId": "x"}] * 1001):
            with self.assertRaises(ValueError):
                self.client.metrics.measurements(records)
        with self.assertRaises(ValueError):
            self.client.knowledge.save({"content": "x" * (5 * 1024 * 1024)})
        with self.assertRaises(ValueError):
            self.client.metrics.measurements([{"measurementId": "x"}], idempotency_key="x\r\nInjected: yes")
        self.assertEqual(self.server.requests, [])

    @patch("shpyrd_warehouse.client.time.sleep")
    def test_rate_limit_respected_with_same_payload(self, sleep):
        self.reply({"error": "Wait"}, 429, **{"Retry-After": "7"})
        self.reply({"id": "r", "status": "accepted"}, 202)
        self.client.metrics.measurements([{"measurementId": "stable", "value": "1.00"}])
        sleep.assert_called_once_with(7)
        self.assertEqual(self.server.requests[0][3], self.server.requests[1][3])

    @patch("shpyrd_warehouse.client.time.sleep")
    def test_long_retry_after_is_returned(self, sleep):
        self.reply({"error": "Wait"}, 429, **{"Retry-After": "120"})
        with self.assertRaises(WarehouseError) as raised:
            self.client.metrics.catalog()
        self.assertEqual(raised.exception.retry_after, 120)
        sleep.assert_not_called()

    def test_permission_errors_do_not_retry_and_redact(self):
        self.reply({"error": "Denied " + TOKEN}, 403)
        with self.assertRaises(WarehouseError) as raised:
            self.client.metrics.catalog()
        self.assertEqual(raised.exception.status, 403)
        self.assertNotIn(TOKEN, str(raised.exception))
        self.assertEqual(len(self.server.requests), 1)

    def test_management_contract(self):
        self.reply({"created": True, "metric": {"key": "x"}}, 201)
        self.assertTrue(self.client.metrics.register({"key": "x"}, dataset={"version": 1, "schema": {"value": "decimal"}})["created"])
        self.assertEqual(self.body()["dataset"]["version"], 1)
        self.reply({"metric": {"revision": 2}})
        self.client.metrics.update("x", expected_revision=1, changes={"name": "New name"})
        self.assertEqual(self.server.requests[-1][:2], ("PATCH", "/api/v1/metrics/definitions/x"))
        self.assertEqual(self.body(), {"expectedRevision": 1, "changes": {"name": "New name"}})
        self.reply({"deleted": True})
        self.client.metrics.delete("x", expected_revision=2)
        self.assertEqual(self.server.requests[-1][:2], ("DELETE", "/api/v1/metrics/definitions/x"))
        self.assertEqual(self.body(), {"expectedRevision": 2})

    @patch("shpyrd_warehouse.client.time.sleep")
    def test_non_idempotent_mutations_do_not_auto_retry(self, sleep):
        for operation in (lambda: self.client.metrics.update("x", expected_revision=1, changes={"name": "x"}),
                          lambda: self.client.knowledge.save({"title": "x"}),
                          lambda: self.client.metrics.query({"metricId": "x", "snapshot": True})):
            self.reply({"error": "unavailable"}, 503)
            with self.assertRaises(WarehouseError):
                operation()
        self.assertEqual(len(self.server.requests), 3)
        sleep.assert_not_called()

    @patch("shpyrd_warehouse.client.time.sleep")
    def test_ingestion_wait_complete_and_failure(self, _sleep):
        self.reply({"id": "r", "status": "accepted"})
        self.reply({"id": "r", "status": "completed"})
        self.assertEqual(self.client.metrics.wait_for_ingestion("r")["status"], "completed")
        self.reply({"id": "bad", "status": "failed", "error": "Invalid sample"})
        with self.assertRaises(IngestionFailed) as raised:
            self.client.metrics.wait_for_ingestion("bad")
        self.assertEqual(raised.exception.receipt["id"], "bad")

    def test_pending_ingestion_timeout(self):
        self.reply({"id": "r", "status": "accepted"})
        with self.assertRaises(TimeoutError):
            self.client.metrics.wait_for_ingestion("r", timeout=0.02, poll_interval=1)

    def test_pagination_and_search_encoding(self):
        self.reply({"metrics": [{"key": "a"}], "nextCursor": "a"})
        self.reply({"metrics": [{"key": "b"}]})
        self.assertEqual([m["key"] for m in self.client.metrics.iter_metrics(query="cash & bank")], ["a", "b"])
        self.assertIn("after=a", self.server.requests[-1][1])
        self.assertIn("q=cash+%26+bank", self.server.requests[0][1])
        self.reply({"documents": [{"id": "1"}], "nextCursor": "1"})
        self.reply({"documents": [{"id": "2"}]})
        self.assertEqual(len(list(self.client.knowledge.iter_documents(collection="sample"))), 2)
        self.reply({"documents": [], "mode": "hybrid"})
        self.assertEqual(self.client.knowledge.search("saldo? & bancos", collection="sample")["mode"], "hybrid")
        self.assertIn("q=saldo%3F+%26+bancos", self.server.requests[-1][1])

    def test_knowledge_stable_identity_lookup(self):
        self.reply({"id": "d", "collection": "finance", "key": "bank/cash?#%"})
        self.assertEqual(self.client.knowledge.get_by_key("finance", "bank/cash?#%")['id'], 'd')
        self.assertIn('/knowledge/documents/by-key?', self.server.requests[-1][1])
        self.assertIn('key=bank%2Fcash%3F%23%25', self.server.requests[-1][1])
        self.assertIn('collection=finance', self.server.requests[-1][1])

    def test_knowledge_revisions_and_archive(self):
        self.reply({"id": "d", "revision": 2, "active": False})
        self.assertFalse(self.client.knowledge.archive("d", revision=1)["active"])
        self.assertEqual(self.body()["revision"], 1)
        self.assertEqual(self.body()["action"], "archive")
        self.reply({"document": {"id": "d"}, "versions": []})
        self.client.knowledge.history("d")
        self.assertTrue(self.server.requests[-1][1].endswith("/d/history"))
        self.reply({"id": "d", "revision": 3, "active": True})
        self.client.knowledge.restore("d", revision=2, restore_revision=1)
        self.assertEqual(self.body()["restoreRevision"], 1)
        self.assertEqual(self.body()["revision"], 2)

    def test_remaining_metric_endpoints(self):
        self.reply({"metric": {"key": "a"}})
        self.assertEqual(self.client.metrics.get("a")["key"], "a")
        self.reply({"id": "r"}, 202)
        self.client.metrics.events("orders", [{"eventId": "order-1"}], schema_version=2)
        self.assertEqual(self.body()["datasetKey"], "orders")
        self.assertEqual(self.body()["schemaVersion"], 2)
        self.reply({"id": "r"}, 202)
        self.client.metrics.aggregates([{"aggregateId": "hour-1"}])
        self.assertIn("aggregates", self.body())
        self.reply({"id": "r"}, 202)
        self.client.metrics.corrections({"mode": "measurements", "recordId": "x", "revision": 2, "tombstone": True})
        self.assertTrue(self.body()["tombstone"])
        self.reply({"ok": True})
        self.client.metrics.coverage({"metricKey": "a"})
        self.assertTrue(self.server.requests[-1][1].endswith("/coverage"))
        self.reply({"value": "123456789012345678.90", "series": []})
        self.assertEqual(self.client.metrics.query({"metricId": "a"})["value"], "123456789012345678.90")
        self.reply({"id": "snap", "result": {}})
        self.client.metrics.snapshot("snap")
        self.assertTrue(self.server.requests[-1][1].endswith("/snapshots/snap"))
        self.reply({"id": "doc", "active": False})
        self.assertFalse(self.client.knowledge.get("doc")["active"])


if __name__ == "__main__":
    unittest.main()
