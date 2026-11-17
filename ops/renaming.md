# Renaming Warehouse to zbucket

The application name is `zbucket`, including its UI, page title, health response,
runtime messages, documentation and package metadata. The HTTP API paths and
payload contracts remain `/api/v1` and retain their existing names and semantics.

## SDKs and configuration

| Surface | Current name | Compatibility |
| --- | --- | --- |
| JavaScript package | `@shpyrd/zbucket-browser` | Local package; no registry publication is implied. |
| Server SDK | `ZbucketClient`, `ZbucketHttpError` | `WarehouseClient` and `WarehouseHttpError` alias the same classes. |
| Browser SDK | `ZbucketBrowser`, `zbucket`, `window.zbucket` | Old class/export/global names reference the same implementation and instance. |
| Script asset | `/sdk/zbucket-0.1.0.js` | `/sdk/warehouse-0.1.0.js` serves the same generated bundle. Load one asset. |
| Python package/import | `shpyrd-zbucket` / `shpyrd_zbucket` | `shpyrd_warehouse` and its original class names remain aliases in the new distribution. |
| Access and build settings | `ZBUCKET_ACCESS`, `ZBUCKET_DIST_DIR` | Corresponding `WAREHOUSE_*` variables remain fallbacks. |
| Python environment settings | `ZBUCKET_URL`, `ZBUCKET_TOKEN`, `ZBUCKET_ALLOW_INTERNAL_HTTP` | Corresponding `WAREHOUSE_*` variables remain fallbacks. New values take precedence. |

New TypeScript code can use `src/client/zbucket.ts`; the old client entry point
continues to work. Update the package dependency when installing the newly named
SDK; this change does not publish or replace any existing registry package.

The browser keeps the persisted storage namespace and relay cookie name. This
preserves consent opt-outs, anonymous identities, sessions, signed queued events
and retry IDs across upgrades. A rebrand must not silently restart tracking for
someone who opted out.

## Existing data

`wh_` credentials, physical PostgreSQL table/function names, migration locks,
Knowledge collection keys and document keys remain stable. Renaming these is not
required to change the product name and would affect grants, links or mixed-version
processes. The built-in collection's display name migrates from `Warehouse
documentation` to `zbucket documentation`; custom labels are preserved. Importing
the bundled documentation updates the existing documents through normal revisions.

Keep the existing `DATABASE_URL`. The local database `shpyrd_warehouse` contains
the existing data; `.env.example` uses `zbucket` only as a fresh-install example.
The repository remains in its current checkout directory. Historical experiment
reports and screenshots retain the names recorded when those measurements ran.

## Repository

The public GitHub repository is
[`shpyrd-io/zbucket`](https://github.com/shpyrd-io/zbucket). The existing local
checkout had no Git remote; the new repository preserves its commit history and
is configured as `origin`.

## Deployment

The existing Shpyrd project slug, trusted origin, internal service URL and public
hostname remain actual infrastructure identifiers. `shpyrd.yaml` therefore still
targets `warehouse`, while its application configuration uses `ZBUCKET_ACCESS`.
The Shpyrd project remains Warehouse (`warehouse`). Publishing the GitHub
repository does not rename that project, change DNS or deploy the application.
An infrastructure rename must migrate those resources together and preserve the
database, volumes, network grants, login audience and callers' endpoint settings.
