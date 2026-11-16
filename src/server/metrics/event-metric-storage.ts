export const eventMetricSchema=`
CREATE TABLE IF NOT EXISTS metric_event_processing(
 metric_id uuid PRIMARY KEY REFERENCES metrics ON DELETE CASCADE,source_id uuid NOT NULL REFERENCES metric_sources,
 dataset_key text NOT NULL,name_field text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL CHECK(status IN ('queued','running','completed')),cursor_at timestamptz NOT NULL DEFAULT '-infinity',
 cursor_id text NOT NULL DEFAULT '',cursor_revision integer NOT NULL DEFAULT 0,
 scanned bigint NOT NULL DEFAULT 0,inserted bigint NOT NULL DEFAULT 0,skipped bigint NOT NULL DEFAULT 0,completed_at timestamptz);
ALTER TABLE metric_event_processing ADD COLUMN IF NOT EXISTS include_history boolean NOT NULL DEFAULT true;
ALTER TABLE metric_event_processing ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE metric_event_processing ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS metric_event_processing_pending ON metric_event_processing(created_at) WHERE status<>'completed';`;
