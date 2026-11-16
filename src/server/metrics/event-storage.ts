import type pg from 'pg';
import {eventFields,type EventMapping} from '@/models/metrics/events';
import type {SqlClient} from './service';

export const eventSchema=`
CREATE TABLE IF NOT EXISTS metric_event_datasets(
 source_id uuid NOT NULL, dataset_key text NOT NULL, schema_version integer NOT NULL,
 mapping jsonb NOT NULL, retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
 created_at timestamptz NOT NULL DEFAULT now(), backfilled boolean NOT NULL DEFAULT false,
 cursor_at timestamptz NOT NULL DEFAULT '-infinity', cursor_id text NOT NULL DEFAULT '', cursor_revision integer NOT NULL DEFAULT 0,
 skipped_records integer NOT NULL DEFAULT 0,
 PRIMARY KEY(source_id,dataset_key,schema_version),
 FOREIGN KEY(source_id,dataset_key,schema_version) REFERENCES metric_datasets(source_id,key,version));
CREATE TABLE IF NOT EXISTS metric_event_identities(
 source_id uuid NOT NULL,dataset_key text NOT NULL,schema_version integer NOT NULL,
 anonymous_id text NOT NULL,user_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,dataset_key,schema_version,anonymous_id),
 FOREIGN KEY(source_id,dataset_key,schema_version) REFERENCES metric_event_datasets(source_id,dataset_key,schema_version));
CREATE INDEX IF NOT EXISTS metric_event_identity_user ON metric_event_identities(source_id,dataset_key,schema_version,user_id);
CREATE TABLE IF NOT EXISTS metric_event_index(
 source_id uuid NOT NULL,record_id text NOT NULL,revision integer NOT NULL,
 dataset_key text NOT NULL,schema_version integer NOT NULL,occurred_at timestamptz NOT NULL,
 name text NOT NULL,user_id text,account_id text,session_id text,
 PRIMARY KEY(source_id,record_id),
 FOREIGN KEY(source_id,record_id,revision) REFERENCES metric_record_keys(source_id,record_id,revision),
 FOREIGN KEY(source_id,dataset_key,schema_version) REFERENCES metric_event_datasets(source_id,dataset_key,schema_version));
CREATE INDEX IF NOT EXISTS metric_event_backfill ON metric_record_keys(source_id,((payload->'original'->>'datasetKey')),((payload->'original'->>'schemaVersion')),received_at,record_id,revision) WHERE processed AND payload->'original'->>'mode'='events';
CREATE INDEX IF NOT EXISTS metric_event_time ON metric_event_index(source_id,dataset_key,schema_version,occurred_at DESC,record_id DESC);
CREATE INDEX IF NOT EXISTS metric_event_account ON metric_event_index(source_id,dataset_key,schema_version,account_id,occurred_at DESC,record_id DESC);
CREATE INDEX IF NOT EXISTS metric_event_person ON metric_event_index(source_id,dataset_key,schema_version,user_id,occurred_at DESC,record_id DESC);
CREATE INDEX IF NOT EXISTS metric_event_name ON metric_event_index(source_id,dataset_key,schema_version,name,occurred_at,record_id);
`;

type RecordRow={source_id:string;record_id:string;revision:number;received_at:Date;payload:{original?:{mode?:string;datasetKey?:string;schemaVersion?:number;record?:unknown};tombstone?:boolean}};
async function indexRows(c:SqlClient,rows:RecordRow[],historical=false){
 if(!rows.length)return 0;
 const ids=rows.map(r=>({source_id:r.source_id,record_id:r.record_id,revision:r.revision}));
 const latest=(await c.query(`SELECT r.*,d.mapping,d.retention_days,(r.received_at<d.created_at) AS accepted_before_config FROM jsonb_to_recordset($1::jsonb) b(source_id uuid,record_id text,revision integer)
 JOIN metric_record_keys r USING(source_id,record_id,revision)
 LEFT JOIN metric_event_datasets d ON d.source_id=r.source_id AND d.dataset_key=r.payload->'original'->>'datasetKey' AND d.schema_version::text=r.payload->'original'->>'schemaVersion'
 WHERE NOT EXISTS(SELECT 1 FROM metric_record_keys newer WHERE newer.source_id=r.source_id AND newer.record_id=r.record_id AND newer.revision>r.revision)`,[JSON.stringify(ids)])).rows as (RecordRow&{mapping:EventMapping|null;retention_days:number;accepted_before_config:boolean})[];
 let skipped=0;const rejected=[];const prepared=[];const skippedByDataset=new Map<string,{source:string;key:string;version:number;count:number}>();
 for(const row of latest){
  const o=row.payload.original;if(!row.mapping||o?.mode!=='events'||!o.record||row.payload.tombstone)continue;
  let fields;try{fields=eventFields(o.record,row.mapping);}catch(error){
   // Configuration cannot turn previously accepted work into a poison batch.
   if(!historical&&!row.accepted_before_config)throw error;
   skipped++;rejected.push({source_id:row.source_id,record_id:row.record_id,revision:row.revision});
   if(!historical){const key=JSON.stringify([row.source_id,o.datasetKey,o.schemaVersion]);const group=skippedByDataset.get(key)??{source:row.source_id,key:o.datasetKey!,version:Number(o.schemaVersion),count:0};group.count++;skippedByDataset.set(key,group);}
   continue;
  }
  prepared.push({source_id:row.source_id,record_id:row.record_id,revision:row.revision,dataset_key:o.datasetKey,schema_version:o.schemaVersion,
   occurred_at:fields.occurredAt,name:fields.name,user_id:fields.userId,account_id:fields.accountId,session_id:fields.sessionId,retention_days:row.retention_days});
 }
 // Corrections can change dataset, identity, time or remove the event entirely.
 await c.query(`DELETE FROM metric_event_index e USING jsonb_to_recordset($1::jsonb) r(source_id uuid,record_id text,revision integer)
 WHERE (e.source_id,e.record_id)=(r.source_id,r.record_id) AND e.revision<=r.revision`,[JSON.stringify(latest.map(r=>({source_id:r.source_id,record_id:r.record_id,revision:r.revision})))]);
 if(prepared.length)await c.query(`INSERT INTO metric_event_index(source_id,record_id,revision,dataset_key,schema_version,occurred_at,name,user_id,account_id,session_id)
 SELECT source_id,record_id,revision,dataset_key,schema_version,occurred_at,name,user_id,account_id,session_id FROM jsonb_to_recordset($1::jsonb)
 x(source_id uuid,record_id text,revision integer,dataset_key text,schema_version integer,occurred_at timestamptz,name text,user_id text,account_id text,session_id text,retention_days integer)
 WHERE occurred_at>=now()-make_interval(days=>retention_days)
 ON CONFLICT(source_id,record_id) DO NOTHING`,[JSON.stringify(prepared)]);
 if(rejected.length)await c.query(`UPDATE metric_record_keys r SET payload=r.payload||'{"eventIndexSkipped":true}'::jsonb FROM jsonb_to_recordset($1::jsonb) x(source_id uuid,record_id text,revision integer) WHERE (r.source_id,r.record_id,r.revision)=(x.source_id,x.record_id,x.revision)`,[JSON.stringify(rejected)]);
 for(const skipped of skippedByDataset.values())await c.query('UPDATE metric_event_datasets SET skipped_records=skipped_records+$4 WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3',[skipped.source,skipped.key,skipped.version,skipped.count]);
 return skipped;
}
export async function publishEventIndex(c:pg.PoolClient){
 // Only event-enabled sources need per-record indexing; legacy metric batches stay set based.
 const rows=await c.query(`SELECT b.* FROM metric_batch b WHERE EXISTS(SELECT 1 FROM metric_event_datasets d WHERE d.source_id=b.source_id)`);
 if(rows.rowCount)await indexRows(c,rows.rows);
}
export async function backfillEventIndex(c:pg.PoolClient,batchSize:number){
 // Always lock the source before its configuration. Live publication takes a
 // source lock and FK key-share locks on configuration; reversing that order deadlocks.
 const source=(await c.query(`SELECT s.id FROM metric_sources s WHERE EXISTS(SELECT 1 FROM metric_event_datasets d WHERE d.source_id=s.id AND NOT d.backfilled)
 ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`)).rows[0];if(!source)return 0;
 const config=(await c.query('SELECT *,cursor_at::text AS cursor_at FROM metric_event_datasets WHERE NOT backfilled AND source_id=$1 ORDER BY created_at LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED',[source.id])).rows[0];if(!config)return 0;
 const rows=(await c.query(`SELECT *,received_at::text AS received_cursor FROM metric_record_keys WHERE source_id=$1 AND processed AND payload->'original'->>'mode'='events' AND (received_at,record_id,revision)>($2::timestamptz,$3,$4)
 AND NOT(payload ? 'eventIndexSkipped') AND payload->'original'->>'datasetKey'=$5 AND payload->'original'->>'schemaVersion'=$6
 ORDER BY received_at,record_id,revision LIMIT $7`,[config.source_id,config.cursor_at,config.cursor_id,config.cursor_revision,config.dataset_key,String(config.schema_version),batchSize])).rows;
 const skipped=await indexRows(c,rows,true),last=rows.at(-1);
 await c.query(`UPDATE metric_event_datasets SET backfilled=$4,skipped_records=skipped_records+$5,
 cursor_at=coalesce($6::timestamptz,cursor_at),cursor_id=coalesce($7,cursor_id),cursor_revision=coalesce($8,cursor_revision)
 WHERE source_id=$1 AND dataset_key=$2 AND schema_version=$3`,[config.source_id,config.dataset_key,config.schema_version,rows.length<batchSize,skipped,last?.received_cursor,last?.record_id,last?.revision]);
 return rows.length;
}
