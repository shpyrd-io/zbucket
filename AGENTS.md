# Warehouse

English code, UI and docs. Portuguese conversation. Standalone data repository PoC.

- Keep only Metrics, Knowledge and shared integrations/identity. Never import Tower business workflows.
- One integration identity and `wh_` credential covers granted reads/writes. Default deny.
- PostgreSQL with pgvector; never point Warehouse to a Tower database.
- Use the bundled, unmodified `@shpyrd/ui` design system.
- Keep immutable metric contracts, decimal arithmetic, retries, provenance and document revisions.
- Run lint, typecheck, unit tests, PostgreSQL acceptance and build.
- Never copy secrets or deploy without authorization.
