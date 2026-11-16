// Generation changes and publication share a transaction. Statement triggers bump
// once per affected source, never once per event. Deletions invalidate cached data immediately.
export const funnelSchema=`
CREATE TABLE IF NOT EXISTS metric_event_generations(source_id uuid PRIMARY KEY REFERENCES metric_sources,generation bigint NOT NULL DEFAULT 0,erasure bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS metric_funnel_runs(
 id uuid PRIMARY KEY,query_hash text NOT NULL,source_id uuid NOT NULL REFERENCES metric_sources,
 query jsonb NOT NULL,owner_key text NOT NULL,status text NOT NULL DEFAULT 'queued',
 generation bigint,erasure bigint,counts jsonb,metadata jsonb,
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,completed_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),error text,processed_events bigint NOT NULL DEFAULT 0,
 CHECK(status IN ('queued','running','completed','failed','cancelled')));
CREATE INDEX IF NOT EXISTS metric_funnel_lookup ON metric_funnel_runs(query_hash,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS metric_funnel_active ON metric_funnel_runs(query_hash) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS metric_funnel_queue ON metric_funnel_runs(available_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS metric_funnel_members(
 run_id uuid NOT NULL REFERENCES metric_funnel_runs ON DELETE CASCADE,attempt uuid NOT NULL,
 actor text COLLATE "C" NOT NULL,reached smallint NOT NULL,
 PRIMARY KEY(run_id,attempt,actor));
CREATE INDEX IF NOT EXISTS metric_funnel_stage ON metric_funnel_members(run_id,attempt,reached,actor);
CREATE OR REPLACE FUNCTION warehouse_event_generation_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO metric_event_generations(source_id,generation,erasure)
 SELECT DISTINCT source_id,1,CASE WHEN TG_TABLE_NAME='metric_event_identities' THEN 1 ELSE 0 END FROM new_events ORDER BY source_id
 ON CONFLICT(source_id) DO UPDATE SET generation=metric_event_generations.generation+1,erasure=metric_event_generations.erasure+EXCLUDED.erasure;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION warehouse_event_generation_old() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO metric_event_generations(source_id,generation,erasure)
 SELECT DISTINCT source_id,1,1 FROM old_events ORDER BY source_id
 ON CONFLICT(source_id) DO UPDATE SET generation=metric_event_generations.generation+1,erasure=metric_event_generations.erasure+1;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION warehouse_event_generation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO metric_event_generations(source_id,generation,erasure)
 SELECT source_id,1,1 FROM (SELECT source_id FROM old_events UNION SELECT source_id FROM new_events) s ORDER BY source_id
 ON CONFLICT(source_id) DO UPDATE SET generation=metric_event_generations.generation+1,erasure=metric_event_generations.erasure+1;
 RETURN NULL;
END $$;
${['metric_event_index','metric_event_identities'].map(table=>`
CREATE OR REPLACE TRIGGER funnel_insert AFTER INSERT ON ${table} REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION warehouse_event_generation_new();
CREATE OR REPLACE TRIGGER funnel_delete AFTER DELETE ON ${table} REFERENCING OLD TABLE AS old_events FOR EACH STATEMENT EXECUTE FUNCTION warehouse_event_generation_old();
CREATE OR REPLACE TRIGGER funnel_update AFTER UPDATE ON ${table} REFERENCING OLD TABLE AS old_events NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION warehouse_event_generation_update();`).join('')}
`;
