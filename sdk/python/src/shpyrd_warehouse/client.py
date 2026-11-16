"""Explicit API operations; no implicit permission changes or numeric coercion."""
from __future__ import annotations

import json
import math
import os
import random
import re
import time
from datetime import datetime, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from typing import Any, Iterator, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class WarehouseError(Exception):
    """An API error. Inspect status and retry_after without parsing message text."""

    def __init__(self, status: int, message: str, retry_after: float | None = None):
        self.status = status
        self.retry_after = retry_after
        super().__init__(f"Warehouse HTTP {status}: {message}")


class WarehouseTransportError(Exception):
    """No usable JSON response. A write may have succeeded; preserve record IDs."""


class IngestionFailed(Exception):
    def __init__(self, receipt: dict[str, Any]):
        self.receipt = receipt
        super().__init__(f"Ingestion {receipt.get('id')} failed: {receipt.get('error') or 'see receipt'}")


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Decimal values must be finite.")
        return format(value, "f")
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise ValueError("Timestamps must include a timezone.")
        return value.isoformat()
    if isinstance(value, float):
        raise TypeError("Use decimal strings or Decimal for measurements, not binary floats.")
    if isinstance(value, Mapping):
        if any(not isinstance(k, str) for k in value):
            raise TypeError("JSON object keys must be strings.")
        return {k: _json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(v) for v in value]
    return value


def _segment(value: str) -> str:
    if not isinstance(value, str) or not value or value in (".", ".."):
        raise ValueError("Supply a nonempty key or ID.")
    return quote(value, safe="")


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    return max(0.0, seconds) if math.isfinite(seconds) else None


class WarehouseClient:
    """Use a backend wh_ token and an origin URL (without /api/v1).

    HTTPS is required outside loopback. Explicit allow_internal_http permits
    Kubernetes *.svc.cluster.local services. Redirects are never followed.
    Safe reads, registrations and ID-stable ingestion retry transient failures;
    metadata/document edits are never silently retried or revision-rebased.
    """

    def __init__(self, base_url: str, token: str, *, timeout: float = 30,
                 max_retries: int = 2, allow_internal_http: bool = False):
        url = urlsplit(base_url)
        if (url.scheme not in ("https", "http") or not url.hostname or url.username
                or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("Use an origin URL without credentials, path, query or fragment.")
        loopback = url.hostname in ("localhost", "127.0.0.1", "::1")
        internal = bool(re.fullmatch(r"[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local", url.hostname))
        if url.scheme == "http" and not (loopback or (allow_internal_http and internal)):
            raise ValueError("Use HTTPS, loopback, or explicitly allow a Kubernetes service origin.")
        if not re.fullmatch(r"wh_[A-Za-z0-9_-]{43}", token):
            raise ValueError("Supply a valid Warehouse integration token (wh_…).")
        if not math.isfinite(timeout) or timeout <= 0 or not isinstance(max_retries, int) or not 0 <= max_retries <= 5:
            raise ValueError("timeout must be positive; max_retries must be an integer from 0 to 5.")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._token = token
        self._opener = build_opener(_NoRedirects())
        self.metrics = Metrics(self)
        self.knowledge = Knowledge(self)

    @classmethod
    def from_env(cls, **options: Any) -> WarehouseClient:
        """Read environment variables only. Does not execute or auto-load .env files."""
        options.setdefault("allow_internal_http", os.environ.get("WAREHOUSE_ALLOW_INTERNAL_HTTP") == "1")
        return cls(os.environ["WAREHOUSE_URL"], os.environ["WAREHOUSE_TOKEN"], **options)

    def __repr__(self) -> str:
        return f"WarehouseClient(base_url={self.base_url!r}, token=<redacted>)"

    def _request(self, method: str, path: str, body: Mapping[str, Any] | None = None, *,
                 params: Mapping[str, Any] | None = None, retry_safe: bool = False,
                 idempotency_key: str | None = None, deadline: float | None = None) -> dict[str, Any]:
        url = self.base_url + "/api/v1/" + path
        if params:
            url += "?" + urlencode({k: v for k, v in params.items() if v is not None})
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json",
                   "User-Agent": "shpyrd-warehouse-python/0.1.0"}
        payload = None
        if body is not None:
            payload = json.dumps(_json_value(body), ensure_ascii=False, allow_nan=False,
                                 separators=(",", ":")).encode("utf-8")
            if len(payload) > 5 * 1024 * 1024:
                raise ValueError("Warehouse requests may not exceed 5 MiB.")
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            if not idempotency_key or len(idempotency_key) > 200 or not idempotency_key.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in idempotency_key):
                raise ValueError("Use a nonempty ASCII idempotency key, at most 200 characters.")
            headers["Idempotency-Key"] = idempotency_key
        attempts = self.max_retries + 1 if retry_safe else 1
        for attempt in range(attempts):
            remaining = self.timeout if deadline is None else min(self.timeout, deadline - time.monotonic())
            if remaining <= 0:
                raise TimeoutError("Warehouse operation timed out.")
            try:
                request = Request(url, data=payload, headers=headers, method=method)
                try:
                    response = self._opener.open(request, timeout=remaining)
                except HTTPError as error:
                    response = error
                with response:
                    status = response.status
                    content_type = response.headers.get("Content-Type", "").lower()
                    delay = _retry_after(response.headers.get("Retry-After"))
                    raw = response.read(32 * 1024 * 1024 + 1)
                if 300 <= status < 400:
                    raise WarehouseError(status, "Redirect refused. Use the internal API or authenticated machine ingress.")
                if len(raw) > 32 * 1024 * 1024:
                    raise WarehouseTransportError("Response exceeds 32 MiB; narrow the query or paginate.")
                data: Any = None
                if "application/json" in content_type or "+json" in content_type:
                    try:
                        data = json.loads(raw, parse_float=Decimal)
                    except (ValueError, UnicodeDecodeError):
                        pass
                if status >= 400:
                    message = data.get("error", "Request failed.") if isinstance(data, dict) else "Non-JSON response; check API origin and gateway."
                    raise WarehouseError(status, str(message).replace(self._token, "<redacted>"), delay)
                if not isinstance(data, dict):
                    raise WarehouseTransportError("Expected a JSON object; check API origin and gateway.")
                return data
            except WarehouseError as error:
                if error.status not in (429, 502, 503, 504) or attempt + 1 == attempts:
                    raise
                delay = error.retry_after
                if delay is not None and delay > 60:
                    raise  # Let the caller schedule a later retry; never ignore Retry-After.
            except (URLError, TimeoutError, OSError, HTTPException):
                if attempt + 1 == attempts:
                    raise WarehouseTransportError("Warehouse connection failed. Preserve record IDs before retrying a write.") from None
                delay = None
            pause = delay if delay is not None else min(2 ** attempt, 8) + random.uniform(0, 0.25)
            if deadline is not None and time.monotonic() + pause >= deadline:
                raise TimeoutError("Warehouse operation timed out.")
            time.sleep(pause)
        raise AssertionError("Unreachable")


class Metrics:
    def __init__(self, client: WarehouseClient):
        self._client = client

    def catalog(self, *, query: str = "", after: str | None = None) -> dict[str, Any]:
        return self._client._request("GET", "metrics/catalog", params={"q": query, "after": after}, retry_safe=True)

    def iter_metrics(self, *, query: str = "") -> Iterator[dict[str, Any]]:
        after = None
        seen = set()
        while True:
            page = self.catalog(query=query, after=after)
            yield from page["metrics"]
            after = page.get("nextCursor")
            if not after:
                return
            if after in seen:
                raise WarehouseTransportError("Metric catalog returned a repeated pagination cursor.")
            seen.add(after)

    def get(self, key_or_id: str) -> dict[str, Any]:
        return self._client._request("GET", "metrics/definition/" + _segment(key_or_id), retry_safe=True)["metric"]

    def register(self, definition: Mapping[str, Any], *, dataset: Mapping[str, Any] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"definition": definition}
        if dataset is not None:
            body["dataset"] = dataset
        return self._client._request("POST", "metrics/definitions", body, retry_safe=True)

    def update(self, key_or_id: str, *, expected_revision: int, changes: Mapping[str, Any]) -> dict[str, Any]:
        return self._client._request("PATCH", "metrics/definitions/" + _segment(key_or_id),
                                    {"expectedRevision": expected_revision, "changes": changes})["metric"]

    def delete(self, key_or_id: str, *, expected_revision: int) -> dict[str, Any]:
        return self._client._request("DELETE", "metrics/definitions/" + _segment(key_or_id),
                                    {"expectedRevision": expected_revision})

    def _ingest(self, mode: str, records: Sequence[Mapping[str, Any]], identity: str, *,
                idempotency_key: str | None = None, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if not 1 <= len(records) <= 1000:
            raise ValueError("Send 1–1,000 records per batch.")
        if any(not isinstance(r.get(identity), str) or not r[identity].strip() for r in records):
            raise ValueError(f"Each record needs a stable {identity}; retries must reuse it.")
        return self._client._request("POST", "metrics/" + mode, {**(extra or {}), mode: list(records)},
                                     idempotency_key=idempotency_key, retry_safe=True)

    def measurements(self, records: Sequence[Mapping[str, Any]], *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._ingest("measurements", records, "measurementId", idempotency_key=idempotency_key)

    def events(self, dataset_key: str, records: Sequence[Mapping[str, Any]], *, schema_version: int = 1,
               idempotency_key: str | None = None) -> dict[str, Any]:
        return self._ingest("events", records, "eventId", extra={"datasetKey": dataset_key, "schemaVersion": schema_version}, idempotency_key=idempotency_key)

    def aggregates(self, records: Sequence[Mapping[str, Any]], *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._ingest("aggregates", records, "aggregateId", idempotency_key=idempotency_key)

    def corrections(self, body: Mapping[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._client._request("POST", "metrics/corrections", body, idempotency_key=idempotency_key)

    def coverage(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._client._request("POST", "metrics/coverage", body)

    def receipt(self, ingestion_id: str) -> dict[str, Any]:
        return self._client._request("GET", "metrics/ingestions/" + _segment(ingestion_id), retry_safe=True)

    def wait_for_ingestion(self, ingestion_id: str, *, timeout: float = 120, poll_interval: float = 1) -> dict[str, Any]:
        if not math.isfinite(timeout) or not math.isfinite(poll_interval) or timeout <= 0 or poll_interval <= 0:
            raise ValueError("Timeout and poll interval must be finite and positive.")
        deadline = time.monotonic() + timeout
        while True:
            receipt = self._client._request("GET", "metrics/ingestions/" + _segment(ingestion_id), retry_safe=True, deadline=deadline)
            if receipt["status"] == "completed":
                return receipt
            if receipt["status"] == "failed":
                raise IngestionFailed(receipt)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Ingestion {ingestion_id} is still pending; poll the same receipt later.")
            time.sleep(min(poll_interval, remaining))

    def event_timeline(self, query: Mapping[str, Any]) -> dict[str, Any]:
        """Read retained event history with explicit dataset permission."""
        return self._client._request("POST", "metrics/event-timeline", query, retry_safe=True)

    def event_funnel(self, query: Mapping[str, Any]) -> dict[str, Any]:
        """Evaluate an ordered funnel by person or account."""
        return self._client._request("POST", "metrics/event-funnel", query, retry_safe=True)

    def query(self, query: Mapping[str, Any]) -> dict[str, Any]:
        return self._client._request("POST", "metrics/query", query, retry_safe=not query.get("snapshot"))

    def snapshot(self, snapshot_id: str) -> dict[str, Any]:
        return self._client._request("GET", "metrics/snapshots/" + _segment(snapshot_id), retry_safe=True)


class Knowledge:
    def __init__(self, client: WarehouseClient):
        self._client = client

    def list(self, *, collection: str | None = None, after: str | None = None) -> dict[str, Any]:
        return self._client._request("GET", "knowledge/documents", params={"collection": collection, "after": after}, retry_safe=True)

    def iter_documents(self, *, collection: str | None = None) -> Iterator[dict[str, Any]]:
        after = None
        seen = set()
        while True:
            page = self.list(collection=collection, after=after)
            yield from page["documents"]
            after = page.get("nextCursor")
            if not after:
                return
            if after in seen:
                raise WarehouseTransportError("Document catalog returned a repeated pagination cursor.")
            seen.add(after)

    def search(self, query: str, *, collection: str | None = None) -> dict[str, Any]:
        if not query.strip():
            raise ValueError("Search requires nonempty text; use list() for the catalog.")
        return self._client._request("GET", "knowledge/documents", params={"q": query, "collection": collection}, retry_safe=True)

    def get(self, document_id: str) -> dict[str, Any]:
        return self._client._request("GET", "knowledge/documents/" + _segment(document_id), retry_safe=True)

    def get_by_key(self, collection: str, key: str) -> dict[str, Any]:
        return self._client._request("GET", "knowledge/documents/by-key", params={"collection": collection, "key": key}, retry_safe=True)

    def save(self, document: Mapping[str, Any]) -> dict[str, Any]:
        """Full replacement, not PATCH. Supply current revision for changes."""
        return self._client._request("POST", "knowledge/documents", document)

    def history(self, document_id: str) -> dict[str, Any]:
        return self._client._request("GET", "knowledge/documents/" + _segment(document_id) + "/history", retry_safe=True)

    def archive(self, document_id: str, *, revision: int, reason: str = "Archived by publisher") -> dict[str, Any]:
        return self._client._request("POST", "knowledge/documents/" + _segment(document_id),
                                    {"action": "archive", "revision": revision, "reason": reason})

    def restore(self, document_id: str, *, revision: int, restore_revision: int, reason: str = "Restored by publisher") -> dict[str, Any]:
        return self._client._request("POST", "knowledge/documents/" + _segment(document_id),
                                    {"action": "restore", "revision": revision, "restoreRevision": restore_revision, "reason": reason})
