import type pg from 'pg';
import {metricsDb,transaction} from './db/metrics';
let ready:Promise<void>|undefined;
export async function database(){const pool=await metricsDb();ready??=migrateWarehouse(pool).catch(e=>{ready=undefined;throw e;});await ready;return pool;}
export async function migrateWarehouse(pool:pg.Pool){await transaction(pool,async c=>{
 await c.query("SELECT pg_advisory_xact_lock(hashtext('warehouse-schema'))");
 await c.query(`CREATE EXTENSION IF NOT EXISTS vector;
 CREATE TABLE IF NOT EXISTS warehouse_users(id uuid PRIMARY KEY,issuer text NOT NULL,subject text NOT NULL,name text NOT NULL,email text NOT NULL,UNIQUE(issuer,subject));
 CREATE TABLE IF NOT EXISTS warehouse_apps(id uuid PRIMARY KEY,name text NOT NULL,source_id uuid UNIQUE NOT NULL REFERENCES metric_sources,permissions jsonb NOT NULL,active boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS warehouse_app_name ON warehouse_apps(lower(name));
 CREATE TABLE IF NOT EXISTS warehouse_credentials(id uuid PRIMARY KEY,app_id uuid NOT NULL REFERENCES warehouse_apps,secret_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,last_used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS warehouse_rate_limits(app_id uuid PRIMARY KEY,window_start timestamptz NOT NULL,requests integer NOT NULL);
 CREATE TABLE IF NOT EXISTS warehouse_event_rate_limits(app_id uuid PRIMARY KEY REFERENCES warehouse_apps(id),window_start timestamptz NOT NULL,requests integer NOT NULL,events integer NOT NULL);
 CREATE TABLE IF NOT EXISTS warehouse_audit(id uuid PRIMARY KEY,actor_id uuid NOT NULL,action text NOT NULL,target text NOT NULL,status integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS warehouse_snapshots(id uuid PRIMARY KEY,app_id uuid NOT NULL,metric_key text NOT NULL,query jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS knowledge_collections(key text PRIMARY KEY,name text NOT NULL);
 INSERT INTO knowledge_collections VALUES('general','General'),('warehouse','Warehouse documentation') ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS knowledge_documents(id uuid PRIMARY KEY,collection text NOT NULL REFERENCES knowledge_collections,key text NOT NULL,title text NOT NULL,content text NOT NULL,category text NOT NULL DEFAULT '',tags jsonb NOT NULL DEFAULT '[]',source_type text NOT NULL DEFAULT 'reference',source_url text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,owner_app_id uuid REFERENCES warehouse_apps,index_status text NOT NULL DEFAULT 'pending',index_error text,index_attempts integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(collection,key));
 CREATE TABLE IF NOT EXISTS knowledge_revisions(document_id uuid NOT NULL REFERENCES knowledge_documents,revision integer NOT NULL,document jsonb NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(document_id,revision));
 CREATE TABLE IF NOT EXISTS knowledge_chunks(document_id uuid NOT NULL REFERENCES knowledge_documents,revision integer NOT NULL,ordinal integer NOT NULL,content text NOT NULL,embedding vector(1024),embedding_model text,PRIMARY KEY(document_id,ordinal));
 CREATE INDEX IF NOT EXISTS knowledge_chunks_fts ON knowledge_chunks USING gin(to_tsvector('simple',content));
 CREATE INDEX IF NOT EXISTS knowledge_embedding ON knowledge_chunks USING hnsw(embedding vector_cosine_ops);
 CREATE INDEX IF NOT EXISTS knowledge_document_list ON knowledge_documents(collection,active,updated_at DESC);
 `);
});}
