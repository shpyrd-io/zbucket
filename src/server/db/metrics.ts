import pg from 'pg';
import { check } from '@/models/metrics/validation';
export type MetricDb = pg.Pool;
export function metricsConnection(url=process.env.DATABASE_URL){check(url?.startsWith('postgres'),'Metrics requires PostgreSQL.',503);return new pg.Pool({connectionString:url,max:3,application_name:'warehouse-metrics',statement_timeout:15000});}
let pool:pg.Pool|undefined,ready:Promise<void>|undefined;
export async function metricsDb(){pool??=metricsConnection();ready??=migrateMetrics(pool).catch(e=>{ready=undefined;throw e;});await ready;return pool;}
export async function migrateMetrics(pool:pg.Pool){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('warehouse-metrics-migration'))");await c.query(`
CREATE TABLE IF NOT EXISTS metric_library(id uuid PRIMARY KEY,name text NOT NULL,kind text NOT NULL CHECK(kind IN ('query','view','dashboard')),visibility text NOT NULL CHECK(visibility IN ('private','company')),owner_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1,config jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS metric_library_owner ON metric_library(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS metric_rollups(metric_id uuid NOT NULL,version integer NOT NULL,level text NOT NULL,bucket timestamptz NOT NULL,ends_at timestamptz NOT NULL,dimensions jsonb NOT NULL,total numeric NOT NULL,n numeric NOT NULL,d numeric NOT NULL,min numeric,max numeric,last numeric,last_at timestamptz,last_key text,count bigint NOT NULL,received_at timestamptz,PRIMARY KEY(metric_id,version,level,bucket,dimensions));
CREATE INDEX IF NOT EXISTS metric_rollups_series ON metric_rollups(metric_id,version,level,dimensions,bucket DESC);
CREATE TABLE IF NOT EXISTS metric_retention_watermarks(metric_id uuid NOT NULL,version integer NOT NULL,raw_before timestamptz,PRIMARY KEY(metric_id,version));
CREATE TABLE IF NOT EXISTS metric_imports(id uuid PRIMARY KEY,source_id uuid NOT NULL,config jsonb NOT NULL,status text NOT NULL DEFAULT 'uploading',expected_rows bigint NOT NULL,expected_bytes bigint NOT NULL,uploaded_bytes bigint NOT NULL DEFAULT 0,processed_rows bigint NOT NULL DEFAULT 0,checksum text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metric_import_errors(import_id uuid REFERENCES metric_imports,ends_at_row bigint NOT NULL,message text NOT NULL,PRIMARY KEY(import_id,ends_at_row));
CREATE TABLE IF NOT EXISTS metric_sources(id uuid PRIMARY KEY,name text NOT NULL,owner_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE metric_sources ADD COLUMN IF NOT EXISTS last_processed_at timestamptz;
CREATE TABLE IF NOT EXISTS metrics(id uuid PRIMARY KEY,key text NOT NULL UNIQUE,version integer NOT NULL,owner_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
-- Keep registrations after empty-metric deletion so a stable key never changes meaning.
CREATE TABLE IF NOT EXISTS metric_registrations(key text PRIMARY KEY,metric_id uuid UNIQUE NOT NULL,app_id uuid NOT NULL,request_hash text NOT NULL,has_data boolean NOT NULL DEFAULT false,deleted_at timestamptz,deletion_revision integer,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS metric_registrations_app ON metric_registrations(app_id,key);
CREATE TABLE IF NOT EXISTS metric_definition_aliases(original_metric_id uuid NOT NULL,original_version integer NOT NULL,metric_id uuid NOT NULL REFERENCES metrics,version integer NOT NULL,PRIMARY KEY(original_metric_id,original_version));
CREATE TABLE IF NOT EXISTS metric_legacy_definitions(original_metric_id uuid NOT NULL,original_key text NOT NULL,original_version integer NOT NULL,definition jsonb NOT NULL,metric_id uuid NOT NULL,version integer NOT NULL,PRIMARY KEY(original_metric_id,original_version));
CREATE TABLE IF NOT EXISTS metric_definition_versions(metric_id uuid REFERENCES metrics,version integer NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(metric_id,version));
ALTER TABLE metric_definition_versions ADD COLUMN IF NOT EXISTS reporting_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE metric_definition_versions ADD COLUMN IF NOT EXISTS reporting_revision integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS metric_definition_source ON metric_definition_versions((config->>'sourceId'),(config->>'datasetKey'),(config->>'inputMode'),(config->>'status'));
CREATE TABLE IF NOT EXISTS metric_datasets(source_id uuid REFERENCES metric_sources,key text NOT NULL,version integer NOT NULL,schema jsonb NOT NULL,PRIMARY KEY(source_id,key,version));
CREATE TABLE IF NOT EXISTS metric_ingestions(id uuid PRIMARY KEY,source_id uuid REFERENCES metric_sources,status text NOT NULL DEFAULT 'accepted',request_key text,payload_hash text NOT NULL,record_count integer NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(source_id,request_key));
CREATE INDEX IF NOT EXISTS metric_source_receipts ON metric_ingestions(source_id,created_at DESC);
CREATE INDEX IF NOT EXISTS metric_source_backlog ON metric_ingestions(source_id,created_at) WHERE status='accepted';
CREATE TABLE IF NOT EXISTS metric_record_keys(source_id uuid REFERENCES metric_sources,record_id text NOT NULL,revision integer NOT NULL,hash text NOT NULL,ingestion_id uuid REFERENCES metric_ingestions,payload jsonb NOT NULL,processed boolean NOT NULL DEFAULT false,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,record_id,revision));
ALTER TABLE metric_record_keys ADD COLUMN IF NOT EXISTS semantic_hash text;
CREATE INDEX IF NOT EXISTS metric_receipt_records ON metric_record_keys(ingestion_id) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS metric_source_pending ON metric_record_keys(source_id,received_at) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS metric_pending ON metric_record_keys(received_at) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS metric_source_intervals ON metric_record_keys(source_id) WHERE jsonb_path_exists(payload,'$.projections[*] ? (@.endsAt != null)');
CREATE TABLE IF NOT EXISTS metric_facts(source_id uuid NOT NULL,record_id text NOT NULL,revision integer NOT NULL,metric_id uuid NOT NULL,version integer NOT NULL,observed_at timestamptz NOT NULL,ends_at timestamptz,dimensions jsonb NOT NULL,v numeric,n numeric NOT NULL DEFAULT 0,d numeric NOT NULL DEFAULT 0,weight numeric NOT NULL DEFAULT 1,identity text,received_at timestamptz NOT NULL,PRIMARY KEY(source_id,record_id,revision,metric_id,version,observed_at)) PARTITION BY RANGE(observed_at);
CREATE TABLE IF NOT EXISTS metric_facts_default PARTITION OF metric_facts DEFAULT;
CREATE INDEX IF NOT EXISTS metric_facts_query ON metric_facts(metric_id,version,observed_at);
CREATE INDEX IF NOT EXISTS metric_facts_received ON metric_facts(metric_id,version,received_at DESC);
CREATE INDEX IF NOT EXISTS metric_facts_record ON metric_facts(source_id,record_id);
CREATE TABLE IF NOT EXISTS metric_aggregate_states(metric_id uuid NOT NULL,version integer NOT NULL,bucket timestamptz NOT NULL,dimensions jsonb NOT NULL,total numeric NOT NULL,weight numeric NOT NULL,n numeric NOT NULL,d numeric NOT NULL,min numeric,max numeric,last numeric,last_at timestamptz,count bigint NOT NULL,generation bigint NOT NULL DEFAULT 1,PRIMARY KEY(metric_id,version,bucket,dimensions));
CREATE TABLE IF NOT EXISTS metric_dimension_sets(metric_id uuid NOT NULL,version integer NOT NULL,dimensions jsonb NOT NULL,PRIMARY KEY(metric_id,version,dimensions));
CREATE TABLE IF NOT EXISTS metric_coverage(source_id uuid NOT NULL,metric_id uuid NOT NULL,version integer NOT NULL,dimensions jsonb NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),CHECK(ends_at>starts_at),PRIMARY KEY(source_id,metric_id,version,dimensions,starts_at,ends_at));
CREATE TABLE IF NOT EXISTS metric_query_snapshots(id uuid PRIMARY KEY,metric_id uuid NOT NULL,query jsonb NOT NULL,result jsonb NOT NULL,author_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metric_goals(id uuid PRIMARY KEY,metric_id uuid NOT NULL,version integer NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metric_alert_rules(id uuid PRIMARY KEY,metric_id uuid NOT NULL,version integer NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metric_alert_episodes(id uuid PRIMARY KEY,rule_id uuid NOT NULL,metric_id uuid NOT NULL,status text NOT NULL,opened_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,value numeric NOT NULL,snapshot_id uuid,recovered_at timestamptz);
ALTER TABLE metric_alert_episodes ADD COLUMN IF NOT EXISTS signal_id uuid;
CREATE TABLE IF NOT EXISTS metric_alert_evaluations(rule_id uuid PRIMARY KEY,breach_since timestamptz,last_evaluated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS metric_episode_active ON metric_alert_episodes(rule_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS metric_links(id uuid PRIMARY KEY,metric_id uuid NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,snapshot_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(metric_id,entity_type,entity_id));
CREATE TABLE IF NOT EXISTS metric_purges(id uuid PRIMARY KEY,metric_id uuid NOT NULL REFERENCES metrics,actor_id uuid NOT NULL,scope jsonb NOT NULL,counts jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS metric_purge_history ON metric_purges(metric_id,created_at DESC);
CREATE TABLE IF NOT EXISTS metric_purged_records(source_id uuid NOT NULL,record_id text NOT NULL,metric_id uuid NOT NULL,version integer NOT NULL,purge_id uuid NOT NULL REFERENCES metric_purges,PRIMARY KEY(source_id,record_id,metric_id,version));
CREATE TABLE IF NOT EXISTS metric_activity(id uuid PRIMARY KEY,metric_id uuid,actor_id uuid,action text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
`);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function transaction<T>(pool:pg.Pool,fn:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
