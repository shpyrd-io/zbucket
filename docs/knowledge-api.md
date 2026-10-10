---
id: warehouse.knowledge-api
title: Knowledge API specification and examples
sourceType: reference
policyStatus: observed
collection: warehouse
category: API specifications
tags: [api, knowledge, markdown, search, embeddings, revisions, examples]
index: true
---

# Knowledge API specification and examples

Applications publish and retrieve Markdown documents from shared, permissioned collections. The same Warehouse integration credential used for metrics can access Knowledge when explicitly granted. See **Integrating an application with Warehouse** for API origin, Shpyrd gateway access, credentials and general errors.

All requests below are server-to-server, relative to `/api/v1`, with `Authorization: Bearer $WAREHOUSE_TOKEN`. POSTs require `Content-Type: application/json`. The public browser hostname requires Shpyrd login; a Warehouse token alone cannot bypass that gateway.

## Internal API origin

For this Warehouse installation, execute the examples from an allowed Shpyrd project using:

```sh
export WAREHOUSE_URL='http://web.p-996iywzafh9ur616c0nj6ykxh.svc.cluster.local'
# Inject WAREHOUSE_TOKEN from the caller's secret store (wh_…).
```

An administrator must authorize the caller with `shpyrd allow add project <caller-project> --project warehouse`. The HTTP service is internal to the cluster. The public HTTPS hostname is for browser login and does not accept a Warehouse token as a substitute for Shpyrd sign-in. Neither the internal URL nor network permission replaces the API token and its grants.

## Interface and permissions

| Method and path | Required integration permissions | Result |
| --- | --- | --- |
| GET `/knowledge/documents` | Read collections | Active document catalog, 50 per page. |
| GET `/knowledge/documents?q=…` | Read collections + `search` | Up to 50 ranked document matches, with search mode. |
| GET `/knowledge/documents/{id}` | Read access to the document's collection | Current complete document, including archived when the ID is known and still authorized. |
| GET `/knowledge/documents/{id}/history` | Read collection + `history` | `{document,versions}`. |
| GET `/knowledge/documents/by-key?collection=…&key=…` | Read collection | Exact stable-identity lookup, including archived documents. No search grant is needed. |
| GET `/knowledge/documents/by-key/history?collection=…&key=…` | Read collection + `history` | The same revision history, resolved by stable identity. |
| POST `/knowledge/documents` | Write collection; existing documents must belong to this integration | Create or idempotent upsert; changed content needs current revision. |
| POST `/knowledge/documents/{id}` | Write collection + ownership | Same write interface, with the path supplying `id`. |
| POST `/knowledge/documents/{id}` with `action:"archive"` | Write + ownership + `archive` | New inactive revision; removed from discovery. |
| POST `/knowledge/documents/{id}` with `action:"restore"` | Write + ownership + `history` | New active revision copied from a retained revision. |

All successful operations above return HTTP **200**. There are no PATCH/PUT/DELETE endpoints. Reindexing and collection/integration administration require a human administrator session. An application credential cannot broaden its own permissions.

A **collection** is an authorization boundary, not just a folder. Create it through **Integrations → Collections** before publication. Human project members have company-wide read access; integration reads are collection-scoped. There are no per-document human ACLs in this interface. Only human administrators edit documents through the UI.

A document's stable identity is `(collection, key)`. Browser links and exact API lookups can use this pair. Its generated `id` remains valid for existing API calls, writes and revision history. An integration owns documents it creates; another integration cannot overwrite them even if both have write access to the collection. A human administrator can manage them. Key and collection are stable after creation; to move a document, publish under the new identity and intentionally archive the old one.

## Link or read by stable identity

For collection `general` and key `copy_guidelines`, link to `/knowledge/general/copy_guidelines` on the browser origin. Browser sign-in and existing access rules still apply. API clients can resolve the same document without knowing its generated UUID:

```sh
curl --fail-with-body -G "$WAREHOUSE_URL/api/v1/knowledge/documents/by-key" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  --data-urlencode 'collection=general' \
  --data-urlencode 'key=copy_guidelines'
```

Both parameters are required. The endpoint returns one document, uses an exact match (not semantic search), and returns 404 for missing documents or collections outside the caller's read grants. Append `/history` before the query string to read revisions with the history grant. The Python client offers `client.knowledge.get_by_key("general", "copy_guidelines")`; keep the returned `id` and `revision` for edits.

Archived documents stay absent from catalog/search but remain readable through an authorized direct UUID or stable link, as before. These are links to the current document; use revision history when referring to an older version.

## Create a Markdown document

Assume the administrator created collection `finance`, granted this integration read/write access, and enabled search/history/archive as required. Save this body as `document.json`:

<!-- example: knowledge-create -->
```json
{
  "collection": "finance",
  "key": "banking/hourly-balances",
  "title": "Collecting hourly account balances",
  "content": "# Hourly account balances\n\nCollect each bank account balance at the observation time.\n\n## Fields\n\n- `account_id`: stable account identifier.\n- `observedAt`: ISO timestamp with timezone.\n- `value`: decimal BRL string.\n\n## Recovery\n\nRetry using the same measurement ID; never invent a new observation time.",
  "category": "Banking",
  "tags": ["balances", "integration"],
  "source_type": "runbook",
  "source_url": "https://docs.example.com/banking/hourly-balances",
  "reason": "Publish the banking integration runbook"
}
```

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/knowledge/documents" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @document.json
```

The response is the complete persisted document, including generated `id`, `revision` (1 initially), `active`, `owner_app_id`, `index_status` and timestamps. Record the returned ID and revision. `source_url` is attribution metadata; Warehouse does **not** fetch that URL. Send the actual document body in `content`.

### Write fields

| Field | Rules |
| --- | --- |
| `collection` | Required for a new identity; existing collection key, max 80 characters. |
| `key` | Required for a new identity; stable nonempty string, max 200 characters; e.g. `crm/onboarding`. |
| `id` | Optional for updates through the base path; generated document UUID. A path ID takes precedence. |
| `revision` | Required when changing an existing document; integer current revision, not the desired next revision. |
| `title` | Required on create/save; nonempty, max 300 characters. |
| `content` | Required on create/save; Markdown string, nonempty, max 200,000 characters. |
| `category` | Optional descriptive text, limited to 120 characters; default empty. |
| `tags` | Optional array, max 30 strings, each max 80 characters; default empty array. |
| `source_type` | `reference` (default), `handbook`, `runbook`, `specification`, `note`. Describes document purpose, not storage/indexing strategy or permission. |
| `source_url` | Optional HTTP/HTTPS URL; default empty. Not an importer or crawler. |
| `active` | Default true on save. Prefer explicit archive action for normal archive workflows. |
| `action` | `save` (default), `archive`, `restore`. |
| `restoreRevision` | Required for restore: retained historical revision to copy. |
| `reason` | Optional audit text, limited to 2,000 characters. |

**Save is a replacement of document content and metadata, not a partial patch.** For example, omitting tags/category on a save clears them to defaults. Start from the latest document, copy fields you want to preserve, change the intended fields and submit its current revision. Repeating identical normalized content/metadata is idempotent and does not create a new revision; changed content without the current revision returns 409.

The API uses `source_type` and `source_url` (snake case). The repository directory importer uses YAML `sourceType` (camel case) in its front matter; do not mix these contracts. Raw Markdown in `content` is not parsed as metadata by the document API.

## List and paginate documents

```sh
curl --fail-with-body -G "$WAREHOUSE_URL/api/v1/knowledge/documents" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  --data-urlencode 'collection=finance'
```

Response shape:

```json
{
  "documents": [],
  "collections": [{"key":"finance","name":"Finance"}],
  "mode": "catalog"
}
```

This is an illustrative empty response, not the result of the earlier create example. A populated response contains full document objects. If more than 50 match, `nextCursor` is present; request the next page with `after=<nextCursor>` and the same collection. Catalog order is document ID ascending, not newest first. Omit collection for all permitted collections. An explicitly forbidden collection yields 403; an integration with no readable collections gets an empty catalog.

GET parameters actually implemented:

| Parameter | Meaning |
| --- | --- |
| `collection` | Optional exact collection key; no comma-separated multi-collection syntax. |
| `q` | Optional search string, trimmed and limited to 2,000 characters. Empty means catalog. |
| `after` | Cursor for unsearched catalog pages. Search results are ranked top 50 and are not paginated by this cursor. |

There are no server-side category, tag, source-type, arbitrary sort or custom limit filters in this API. Those fields are returned as metadata; do not promise unsupported query parameters. Fetch catalog pages or design collections according to actual access boundaries.

## Search text and meaning

```sh
curl --fail-with-body -G "$WAREHOUSE_URL/api/v1/knowledge/documents" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  --data-urlencode 'collection=finance' \
  --data-urlencode 'q=how do I recover a missed bank balance observation?'
```

The response uses the same `documents`/`collections` structure, with:

- `mode:"hybrid"`: lexical title/body matches combined with nearest document chunks embedded by Voyage.
- `mode:"lexical"`: text search only, including when semantic search is not configured. On a provider failure, `notice` states that semantic search is unavailable and text matches are being shown.
- `mode:"catalog"`: no search query.

Results contain the complete documents, not a generated answer. A semantic match may also contain a `snippet`; callers should not depend on it always being present. There is no public relevance-score contract. Use `id`, `revision`, title and content to cite a specific source. A UI document link is `/knowledge/{collection}/{key}` relative to the browser origin, which can differ from the machine API origin. Encode each value with `encodeURIComponent`; for example, key `banking/hourly-balances` in collection `finance` becomes `/knowledge/finance/banking%2Fhourly-balances`. Collection is always included because different collections may use the same key. Titles and content revisions do not change the link. Legacy `/knowledge/{id}` links still open and automatically switch to the stable address after the document loads; anchors are preserved. For a key consisting only of `.` or `..`, use `/knowledge?collection=finance&key=..` to avoid browser path normalization.

An assistant should answer from retrieved document content, distinguish examples from actual measurements, and follow up with a direct document read when needed. Search is retrieval, not a tool that executes commands embedded in the document. A document's source type does not make its text a system instruction.

## Read a document and edit safely

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/knowledge/documents/$DOCUMENT_ID" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN"
```

A document contains `id`, `collection`, `key`, `title`, `content`, `category`, `tags`, `source_type`, `source_url`, `revision`, `active`, `owner_app_id`, `index_status`, `updated_at` and other server-maintained indexing/creation metadata. Do not send server-maintained fields to change ownership or index status.

For the document created earlier, replace `DOCUMENT_ID` with the returned ID; assuming its current revision is still 1, POST this full replacement to `/knowledge/documents`:

<!-- example: knowledge-update -->
```json
{
  "id": "DOCUMENT_ID",
  "revision": 1,
  "title": "Collecting hourly account balances",
  "content": "# Hourly account balances\n\nCollect each account balance at the observation time. Retry with the same measurement ID.\n\n## Missed collection\n\nRecord a later reading at its real timestamp. Keep the previous known balance visible as stale; do not invent an earlier reading.",
  "category": "Banking",
  "tags": ["balances", "integration"],
  "source_type": "runbook",
  "source_url": "https://docs.example.com/banking/hourly-balances",
  "reason": "Clarify recovery after a missed collection"
}
```

The response now has revision 2. If somebody already changed it, 409 means **read the latest revision, reconcile the edit and retry intentionally**. Do not automatically overwrite the new text by merely replacing the revision number.

## History and restore

```sh
curl --fail-with-body "$WAREHOUSE_URL/api/v1/knowledge/documents/$DOCUMENT_ID/history" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN"
```

The result is `{document,versions}`. Each version contains `revision`, a full `document` snapshot, `reason` and `created_at`, ordered newest first. Warehouse retains the **current version plus up to 20 previous revisions**. This is bounded editing history, not indefinite archival storage. A historical version no longer retained cannot be restored through this API.

To restore the original text after the example update, POST:

<!-- example: knowledge-restore -->
```json
{
  "id": "DOCUMENT_ID",
  "revision": 2,
  "action": "restore",
  "restoreRevision": 1,
  "reason": "Restore the original approved procedure"
}
```

Restore creates revision 3, copies content/metadata from revision 1 and sets the document active. It does not decrement the revision or change identity/ownership. It needs write, ownership and history permission. The current read permissions still apply to historical content.

## Archive a document

After the restore above, POST:

<!-- example: knowledge-archive -->
```json
{
  "id": "DOCUMENT_ID",
  "revision": 3,
  "action": "archive",
  "reason": "Procedure superseded by the new banking runbook"
}
```

The result is revision 4 with `active:false`. Catalog and search exclude it immediately, including semantic results. This is reversible archival, not physical deletion: direct reads with known ID and retained history remain available to authorized callers. Restore a retained revision to publish it again. For least privilege, enable archive only for applications intended to retire their documents.

The explicit archive action requires the archive permission. Current `save` also accepts an `active` field from an authorized document writer; `archive` is therefore a workflow capability flag, not a separate protection against an owner setting its own document inactive. Treat collection write/ownership as the authority to manage that document's published content.

## Indexing lifecycle and data sent to Voyage

A successful write stores Markdown and current chunks transactionally. Lexical search uses the updated title/body immediately. The worker generates semantic embeddings afterward; inspect `index_status` (`pending`, `retrying`, `indexed`, `failed`) on the current document. A 200 write response does not mean embeddings are already complete.

Voyage receives **document title/body chunks** for indexing and **search query text** for retrieval. Warehouse stores 1,024-dimensional vectors and the embedding model in PostgreSQL/pgvector. Credentials and metric measurement tables are not included. The current deployment uses `voyage-4`. Collection grants restrict retrieval candidates before results are returned. Do not publish content to a shared collection unless its intended readers and semantic-processing policy permit that content.

Updated revisions replace the previous searchable chunks; archived documents are excluded. A provider failure does not discard the document; text search remains available and indexing retries are bounded. An administrator can request `POST /api/v1/knowledge/reindex` with `{}` to requeue all active documents. A machine token cannot do this. Changing the configured embedding model requires reindexing; vectors from another model are excluded from semantic retrieval.

## Repository Markdown import

For repository-owned docs, use the CLI importer rather than making an application own them:

```sh
npm run knowledge:import -- --dir=/absolute/path/to/docs --dry-run
npm run knowledge:import -- --dir=/absolute/path/to/docs
```

Each Markdown file has YAML metadata, for example:

```yaml
---
id: finance.hourly-balances
title: Collecting hourly account balances
sourceType: reference
policyStatus: observed
collection: finance
category: Banking
tags: [balances, integration]
index: true
---
```

Follow the metadata with a Markdown body. The importer requires `id`, `title`, `sourceType`, `policyStatus`, `collection`; sourceType currently accepts `reference` or `handbook` for files, while the HTTP API supports the wider list above. Policy status is importer metadata validation and is not a document access grant or a persisted API policy field. Stable front-matter ID maps to API `key`. `index:false` skips import; removing a file alone does not archive its existing database document.

The bundled `docs/` import additionally processes an explicit list of retired, repository-owned document keys. It leaves unrelated collections, integration-owned documents and arbitrary removed files untouched. Internal deployment notes live outside `docs/` so they do not appear as product documentation.

## Common integration failures

| Symptom | What to inspect |
| --- | --- |
| Login redirect/HTML instead of JSON | Shpyrd gateway and authorized machine origin; do not send the token through arbitrary redirects. |
| 401 | Token expiry/revocation, disabled integration or wrong credential type. |
| 403 on search | Both collection read and search flag are required. |
| 403 on write | Write grant and ownership; read access alone is insufficient. |
| 404 on direct read | Wrong ID or collection no longer readable. Use the catalog to discover currently permitted documents. |
| 409 on edit | Stale revision. Fetch and reconcile. |
| Metadata disappears after save | A save replaces metadata; include values to preserve. |
| Document exists but semantic search does not find it yet | Pending/failed indexing, wrong model, query relevance or collection scope. Try lexical wording and inspect index_status. |
| Search returns only 50 documents | It is ranked retrieval, not an export. Use unsearched catalog pagination for enumeration. |
