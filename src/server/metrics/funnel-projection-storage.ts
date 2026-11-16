// Additive storage: raw records, existing indexes and the on-demand engine stay valid.
export const funnelProjectionSchema=`
CREATE TABLE IF NOT EXISTS metric_funnel_preprocessing(id boolean PRIMARY KEY DEFAULT true CHECK(id),enabled boolean NOT NULL DEFAULT true);
INSERT INTO metric_funnel_preprocessing(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS metric_funnel_definitions(
 id uuid PRIMARY KEY,definition_hash text NOT NULL UNIQUE,source_id uuid NOT NULL REFERENCES metric_sources,
 dataset_key text NOT NULL,schema_version integer NOT NULL,unit text NOT NULL,query jsonb NOT NULL,names text[] NOT NULL,
 initialized boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 0,
 updated_at timestamptz,as_of timestamptz,attempts integer NOT NULL DEFAULT 0,error text,
 available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),stats jsonb,
 FOREIGN KEY(source_id,dataset_key,schema_version) REFERENCES metric_event_datasets(source_id,dataset_key,schema_version));
ALTER TABLE metric_funnel_definitions ADD COLUMN IF NOT EXISTS processed_events bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS metric_funnel_def_dataset ON metric_funnel_definitions(source_id,dataset_key,schema_version);
CREATE TABLE IF NOT EXISTS metric_funnel_subscriptions(
 library_id uuid PRIMARY KEY REFERENCES metric_library ON DELETE CASCADE,
 definition_id uuid NOT NULL REFERENCES metric_funnel_definitions ON DELETE CASCADE);
ALTER TABLE metric_funnel_subscriptions ADD COLUMN IF NOT EXISTS last_warmed_at timestamptz;
CREATE INDEX IF NOT EXISTS metric_funnel_sub_definition ON metric_funnel_subscriptions(definition_id);
CREATE TABLE IF NOT EXISTS metric_funnel_dirty(
 definition_id uuid NOT NULL REFERENCES metric_funnel_definitions ON DELETE CASCADE,
 actor text COLLATE "C" NOT NULL,version bigint NOT NULL DEFAULT 1,
 queued_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(definition_id,actor));
CREATE TABLE IF NOT EXISTS metric_funnel_occurrences(
 definition_id uuid NOT NULL REFERENCES metric_funnel_definitions ON DELETE CASCADE,
 actor text COLLATE "C" NOT NULL,stage smallint NOT NULL,started_at timestamptz NOT NULL,reached_at timestamptz NOT NULL,
 PRIMARY KEY(definition_id,actor,stage,started_at),CHECK(reached_at>=started_at));
CREATE INDEX IF NOT EXISTS metric_funnel_occurrence_period ON metric_funnel_occurrences(definition_id,started_at,reached_at) INCLUDE(actor,stage);
ALTER TABLE metric_funnel_runs ADD COLUMN IF NOT EXISTS projection_id uuid;
ALTER TABLE metric_funnel_runs ADD COLUMN IF NOT EXISTS projection_revision bigint;
CREATE OR REPLACE FUNCTION warehouse_funnel_dirty_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT (SELECT enabled FROM metric_funnel_preprocessing WHERE id) THEN RETURN NULL; END IF;
 INSERT INTO metric_funnel_dirty(definition_id,actor)
 SELECT DISTINCT d.id,CASE WHEN d.unit='person' THEN coalesce(i.user_id,e.user_id) ELSE e.account_id END
 FROM changed_events e JOIN metric_funnel_definitions d ON (d.source_id,d.dataset_key,d.schema_version)=(e.source_id,e.dataset_key,e.schema_version) AND e.name=ANY(d.names)
 LEFT JOIN metric_event_identities i ON (i.source_id,i.dataset_key,i.schema_version,i.anonymous_id)=(e.source_id,e.dataset_key,e.schema_version,e.user_id)
 WHERE (CASE WHEN d.unit='person' THEN coalesce(i.user_id,e.user_id) ELSE e.account_id END) IS NOT NULL
 ORDER BY 1,2
 ON CONFLICT(definition_id,actor) DO UPDATE SET version=metric_funnel_dirty.version+1;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION warehouse_funnel_dirty_identities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT (SELECT enabled FROM metric_funnel_preprocessing WHERE id) THEN RETURN NULL; END IF;
 INSERT INTO metric_funnel_dirty(definition_id,actor)
 SELECT DISTINCT d.id,a.actor FROM changed_events e
 JOIN metric_funnel_definitions d ON (d.source_id,d.dataset_key,d.schema_version)=(e.source_id,e.dataset_key,e.schema_version) AND d.unit='person'
 CROSS JOIN LATERAL (VALUES(e.anonymous_id),(e.user_id)) a(actor)
 ORDER BY 1,2 ON CONFLICT(definition_id,actor) DO UPDATE SET version=metric_funnel_dirty.version+1;
 RETURN NULL;
END $$;
${['metric_event_index','metric_event_identities'].map(table=>{
 const fn=table==='metric_event_index'?'warehouse_funnel_dirty_events':'warehouse_funnel_dirty_identities';
 return `CREATE OR REPLACE TRIGGER projection_insert AFTER INSERT ON ${table} REFERENCING NEW TABLE AS changed_events FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();
 CREATE OR REPLACE TRIGGER projection_delete AFTER DELETE ON ${table} REFERENCING OLD TABLE AS changed_events FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();
 CREATE OR REPLACE TRIGGER projection_update_old AFTER UPDATE ON ${table} REFERENCING OLD TABLE AS changed_events FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();
 CREATE OR REPLACE TRIGGER projection_update_new AFTER UPDATE ON ${table} REFERENCING NEW TABLE AS changed_events FOR EACH STATEMENT EXECUTE FUNCTION ${fn}();`;
}).join('')}
`;
