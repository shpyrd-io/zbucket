import type pg from 'pg';
import { v7 as uuid } from 'uuid';
import { permissions } from '@/models/permissions';
import { canonical,check,object } from '@/models/metrics/validation';
import { registration,metricPatch,expectedRevision,onlyFields,validateDataset } from '@/models/metrics/registration';
import { DomainError } from '@/models/policy';
import { transaction } from './db/metrics';
import { audit,type Principal } from './access';
import { getMetric,hash,saveDefinitionInTransaction } from './metrics/service';

// Lock ordering: integration -> source advisory -> key -> source row -> metric -> library.
// The source locks serialize accepted ingestion and publication with empty deletion.
export async function manageMetric(pool:pg.Pool,p:Principal,method:string,id:string|undefined,input:unknown) {
  check(p.kind==='integration','Use an integration credential for metric self-publication.',403);
  try{return await transaction(pool,async c=>{
    await c.query("SET LOCAL lock_timeout='5s'");
    const app=(await c.query('SELECT * FROM warehouse_apps WHERE id=$1 FOR UPDATE',[p.id])).rows[0];
    check(app?.active,'Integration is disabled.',403);
    const credential=(await c.query('SELECT id FROM warehouse_credentials WHERE id=$1 AND app_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',[p.credentialId,p.id])).rows[0];
    check(credential,'Credential is expired or revoked.',401);
    const grants=permissions(app.permissions);
    check(grants.metrics.manageOwn,'Enable Create and manage own metrics on this integration.',403);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[app.source_id]);
    if(method==='POST'){
      check(!id,'Use PATCH /metrics/definitions/{key} to edit a metric.',405);
      const request=registration(input,app.source_id),config=request.definition;
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric-key:${config.key}`]);
      const existing=(await c.query('SELECT * FROM metric_registrations WHERE key=$1',[config.key])).rows[0];
      if(existing){
        check(existing.app_id===p.id,'This metric key is unavailable.',409);
        check(!existing.deleted_at,'This deleted metric key is reserved. Use a new key.',409);
        check(existing.request_hash===hash(request),'This key was registered with a different definition. Use PATCH for metadata or a new key for a different contract.',409);
        // A retry must never restore access that an administrator has since removed.
        return {metric:await getMetric(c,existing.metric_id),created:false};
      }
      check(!(await c.query('SELECT 1 FROM metrics WHERE key=$1',[config.key])).rowCount,'This metric key is unavailable.',409);
      const scope=grants.metrics.dimensions[config.key]??{};
      check(Object.keys(scope).every(key=>config.dimensions.includes(key)),'Preconfigured scope contains an undeclared metric dimension.');
      const next=permissions({...grants,metrics:{...grants.metrics,read:[...new Set([...grants.metrics.read,config.key])],write:[...new Set([...grants.metrics.write,config.key])]}});
      if(config.inputMode==='events'){
        if(request.dataset){
          await c.query('INSERT INTO metric_datasets(source_id,key,version,schema) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[app.source_id,config.datasetKey,request.dataset.version,request.dataset.schema]);
          const saved=(await c.query('SELECT schema FROM metric_datasets WHERE source_id=$1 AND key=$2 AND version=$3',[app.source_id,config.datasetKey,request.dataset.version])).rows[0];
          check(canonical(saved.schema)===canonical(request.dataset.schema),'Dataset schema already exists with different fields. Use a new dataset version or key.',409);
        }else{
          const datasets=await c.query('SELECT schema FROM metric_datasets WHERE source_id=$1 AND key=$2',[app.source_id,config.datasetKey]);
          check(datasets.rowCount,'Include dataset with version and schema to publish an event metric.');
          // Every registered schema can feed the metric; require compatible field mappings.
          for(const row of datasets.rows)validateDataset(config,row.schema);
        }
      }
      const metric=await saveDefinitionInTransaction(c,config,p.id);
      await c.query('INSERT INTO metric_registrations(key,metric_id,app_id,request_hash) VALUES($1,$2,$3,$4)',[metric.key,metric.id,p.id,hash(request)]);
      await c.query('UPDATE warehouse_apps SET permissions=$2,revision=revision+1 WHERE id=$1',[p.id,next]);
      await audit(c,p,'metric_registered',metric.key,201);
      return {metric,created:true};
    }
    check(!!id,'Supply a metric key or ID.');
    const owned=(await c.query('SELECT * FROM metric_registrations WHERE (key=$1 OR metric_id::text=$1) AND app_id=$2',[id,p.id])).rows[0];
    check(owned,'Managed metric not found.',404);
    if(method==='PATCH'){
      check(!owned.deleted_at,'Managed metric not found.',404);
      const patch=metricPatch(input);
      const metric=await saveDefinitionInTransaction(c,patch.changes,p.id,owned.metric_id,patch.expectedRevision);
      await audit(c,p,'metric_metadata_updated',metric.key);return {metric};
    }
    check(method==='DELETE','Method not allowed.',405);
    const body=object(input);onlyFields(body,['expectedRevision']);expectedRevision(body.expectedRevision);
    if(owned.deleted_at){check(body.expectedRevision===owned.deletion_revision,'Deletion revision does not match.',409);return {deleted:true,key:owned.key,id:owned.metric_id};}
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric-key:${owned.key}`]);
    await c.query('SELECT id FROM metric_sources WHERE id=$1 FOR UPDATE',[app.source_id]);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`metric:${owned.metric_id}`]);
    const row=(await c.query('SELECT revision FROM metrics WHERE id=$1 FOR UPDATE',[owned.metric_id])).rows[0];
    check(row?.revision===body.expectedRevision,'Metric settings changed. Refresh before deleting.',409);
    check(!owned.has_data,'This metric has accepted measurements or coverage and cannot be deleted. Retire it instead.',409);
    await c.query("SELECT pg_advisory_xact_lock(hashtext('metric-library'))");
    // has_data is committed with acceptance, before publication. Do not scan a
    // source's potentially enormous raw journal to decide whether this metric is unused.
    const used=await c.query(`SELECT 1 FROM metric_dimension_sets WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_facts WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_rollups WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_aggregate_states WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_coverage WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_purges WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_exports WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_query_snapshots WHERE metric_id=$1
      UNION ALL SELECT 1 FROM warehouse_snapshots WHERE metric_key=$2
      UNION ALL SELECT 1 FROM metric_goals WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_alert_rules WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_links WHERE metric_id=$1
      UNION ALL SELECT 1 FROM metric_definition_aliases WHERE metric_id=$1 OR original_metric_id=$1
      UNION ALL SELECT 1 FROM metric_library WHERE config#>>'{query,query,metricId}' IN($1::text,$2) LIMIT 1`,[owned.metric_id,owned.key]);
    check(!used.rowCount,'Metric has data, evidence, exports or saved references. Remove unused references or retire the metric instead.',409);
    await c.query('DELETE FROM metric_retention_watermarks WHERE metric_id=$1',[owned.metric_id]);
    await c.query('DELETE FROM metric_definition_versions WHERE metric_id=$1',[owned.metric_id]);
    await c.query('DELETE FROM metrics WHERE id=$1',[owned.metric_id]);
    await c.query('UPDATE metric_registrations SET deleted_at=now(),deletion_revision=$2 WHERE metric_id=$1',[owned.metric_id,body.expectedRevision]);
    const next=structuredClone(grants);next.metrics.read=next.metrics.read.filter(key=>key!==owned.key);next.metrics.write=next.metrics.write.filter(key=>key!==owned.key);delete next.metrics.dimensions[owned.key];
    await c.query('UPDATE warehouse_apps SET permissions=$2,revision=revision+1 WHERE id=$1',[p.id,next]);
    await c.query('INSERT INTO metric_activity(id,metric_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[uuid(),owned.metric_id,p.id,'empty_metric_deleted',{key:owned.key,revision:body.expectedRevision}]);
    await audit(c,p,'empty_metric_deleted',owned.key);
    return {deleted:true,key:owned.key,id:owned.metric_id};
  });}catch(error){
    if((error as {code?:string}).code==='55P03')throw new DomainError(409,'Metric or integration is busy. Retry shortly.');
    throw error;
  }
}
