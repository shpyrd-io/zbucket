---
id: warehouse.deployment
title: Deploying zbucket on Shpyrd
sourceType: reference
policyStatus: observed
collection: warehouse
category: Deployment
tags: [deployment, authentication, integrations, operations]
index: false
---

# Deploying zbucket

The application is branded **zbucket**. The existing deployment still uses slug
`warehouse` and hostname `https://platform-warehouse.shpyrd.app`; the code rename
does not rename Shpyrd resources or DNS. Exposure is external so the hostname is
reachable from the internet. Access remains `authenticated`: only users admitted
by Shpyrd can enter. Never switch the project to public to make integration
credentials pass through its login gateway. See [rename compatibility](renaming.md).

## Runtime and storage

`shpyrd.yaml` defines a `shared-l` web process and two `shared-m` background processes. The web process reads the injected `PORT`. The `worker` process handles metric ingestion, retention and Voyage indexing; `funnels` processes durable funnel runs, incremental preprocessing and saved-period warming. Both commands are declared in `Procfile`. The release phase migrates the database and imports this repository's documentation before rollout. Synthetic metrics and local users are not deployed or seeded.

PostgreSQL 17 has pgvector, its own 5 GiB disk, a `shared-l` instance and daily backups with continuous WAL archiving retained for seven days. It is attached as `DATABASE_URL`. Web and worker have no persistent filesystem volumes. Metric data, saved evidence and documents are stored in PostgreSQL; API clients retrieve data through JSON queries. There is no file export queue or server-side download storage.

The checked-in `.npmrc` uses `install-links=true` so the bundled, unmodified design system installs as the local package recorded in `package-lock.json`. Run `npm ci` for a reproducible clean installation.

## Configuration

- `ZBUCKET_ACCESS=shpyrd` and `NODE_ENV=production`; Shpyrd supplies `SHPYRD_ISSUER`, `SHPYRD_PROJECT` and `SHPYRD_WORKSPACE`.
- `APP_ORIGIN=https://platform-warehouse.shpyrd.app` is the trusted browser origin for mutations behind the reverse proxy. It is optional: without it, a mutation is accepted from the origin whose host is the request's own `Host` header, which Shpyrd's edge sets to the public hostname. Set it when the application must answer one hostname only.
- `VOYAGE_API_KEY` is a project secret. `VOYAGE_MODEL=voyage-4` is ordinary configuration. Voyage receives document chunks for indexing and search text for queries, with 1,024-dimensional embeddings. Credentials, metric measurements and the local environment file are not sent to Voyage.
- Workspace-global config is disabled: this app does not use OpenRouter.

## Application integrations

The public hostname is protected by Shpyrd's personal login. A zbucket `wh_` credential alone cannot bypass that gateway. For another Shpyrd project, first authorize its network connection with `shpyrd allow add project <caller> --project warehouse`. Configure that caller with `http://web.p-996iywzafh9ur616c0nj6ykxh.svc.cluster.local` (the cluster-only web service on port 80) and a `wh_` credential granting only its required metric keys and Knowledge collections. No callers are allowed automatically.

An external producer needs an explicitly configured machine ingress that preserves its Authorization bearer while retaining zbucket's permission checks. This deployment does not open an anonymous path through the human login gateway. Integration requests never create human users.

## Release and verification

Run lint, typecheck, unit tests, PostgreSQL acceptance and build before publishing
changes to `main`. The project follows the public GitHub repository
`https://github.com/shpyrd-io/zbucket.git`, branch `main`. New commits on that branch
can trigger production builds and deployments; validate changes before pushing.

To attach this source to the existing project, run from this checkout:

```sh
SHPYRD_URL=https://platform.shpyrd.cloud shpyrd deploy \
  --project warehouse --git https://github.com/shpyrd-io/zbucket.git --ref main
```

The command starts a build and rollout, retaining the existing project's database,
credentials and access policy. The workspace override avoids deploying to another
signed-in workspace. A plain `shpyrd deploy` uploads the local committed tree and
changes the source back to an archive; keep using the Git source for this project.
Secrets and local data remain excluded. Verify `/api/health` within the app's
network, readiness and logs for `web`, `worker` and `funnels`, a real personal
sign-in, browser API reads and mutations, and indexed documentation. Verify an
integration using its authorized internal connection when that consuming project
is configured.

Use `shpyrd projects info warehouse`, `shpyrd logs --project warehouse`, `shpyrd pg info db --project warehouse` and `shpyrd volumes list --project warehouse` to inspect the deployment. Releases can be rolled back with `shpyrd rollback --project warehouse`; review schema compatibility before rolling code back.
