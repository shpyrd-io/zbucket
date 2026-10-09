---
id: warehouse.deployment
title: Deploying Warehouse on Shpyrd
sourceType: reference
policyStatus: observed
collection: warehouse
category: Deployment
tags: [deployment, authentication, integrations, operations]
index: false
---

# Deploying Warehouse

The project is **Warehouse**, slug `warehouse`, at `https://platform-warehouse.shpyrd.app`. Exposure is external so the hostname is reachable from the internet. Access remains `authenticated`: only users admitted by Shpyrd can enter. Never switch the project to public to make integration credentials pass through its login gateway.

## Runtime and storage

`shpyrd.yaml` defines a `shared-l` web process and a `shared-m` worker. The web process reads the injected `PORT`. The worker handles metric ingestion, retention, NDJSON exports and Voyage indexing. The release phase migrates the database and imports this repository's documentation before rollout. Synthetic metrics and local users are not deployed or seeded.

PostgreSQL 17 has pgvector, its own 5 GiB disk, a `shared-l` instance and daily backups with continuous WAL archiving retained for seven days. It is attached as `DATABASE_URL`. A separate 5 GiB shared volume named `exports` is mounted at `/data/exports` in both processes, so files produced by the worker can be downloaded by the web process and survive releases. Monitor disk use; the volume size bounds available export capacity. Database backups do not include export files.

The checked-in `.npmrc` uses `install-links=true` so the bundled, unmodified design system installs as the local package recorded in `package-lock.json`. Run `npm ci` for a reproducible clean installation.

## Configuration

- `WAREHOUSE_ACCESS=shpyrd` and `NODE_ENV=production`; Shpyrd supplies `SHPYRD_ISSUER`, `SHPYRD_PROJECT` and `SHPYRD_WORKSPACE`.
- `APP_ORIGIN=https://platform-warehouse.shpyrd.app` is the trusted browser origin for mutations behind the reverse proxy. Update it if the canonical hostname changes.
- `VOYAGE_API_KEY` is a project secret. `VOYAGE_MODEL=voyage-4` is ordinary configuration. Voyage receives document chunks for indexing and search text for queries, with 1,024-dimensional embeddings. Credentials, metric measurements and the local environment file are not sent to Voyage.
- Workspace-global config is disabled: this app does not use OpenRouter.

## Application integrations

The public hostname is protected by Shpyrd's personal login. A Warehouse `wh_` credential alone cannot bypass that gateway. For another Shpyrd project, first authorize its network connection with `shpyrd allow add project <caller> --project warehouse`. Configure that caller with Warehouse's internal service URL and a `wh_` credential granting only its required metric keys and Knowledge collections. No callers are allowed automatically.

An external producer needs an explicitly configured machine ingress that preserves its Authorization bearer while retaining Warehouse's permission checks. This deployment does not open an anonymous path through the human login gateway. Integration requests never create human users.

## Release and verification

Run lint, typecheck, unit tests, PostgreSQL acceptance and build before `shpyrd deploy --project warehouse`. Deployment uses the committed tree. Secrets and local data remain excluded. Verify `/api/health` within the app's network, the worker logs, a real personal sign-in, browser API reads and mutations, and indexed documentation. Verify an integration using its authorized internal connection when that consuming project is configured.

Use `shpyrd projects info warehouse`, `shpyrd logs --project warehouse`, `shpyrd pg info db --project warehouse` and `shpyrd volumes list --project warehouse` to inspect the deployment. Releases can be rolled back with `shpyrd rollback --project warehouse`; review schema compatibility before rolling code back.
