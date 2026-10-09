import type pg from 'pg';
import { v7 as uuid } from 'uuid';
import { transaction } from '@/server/db/metrics';
import { queryMetric } from './query';
import { metricPeriod } from '@/models/metrics/calendar';
// Only current periods are evaluated. Historical imports never replay old notifications.
export async function evaluateMetricAlerts(pool:pg.Pool,now=new Date()){
 const rules=await pool.query(`SELECT r.* FROM metric_alert_rules r LEFT JOIN metric_alert_evaluations e ON e.rule_id=r.id WHERE (r.config->>'active')::boolean ORDER BY e.last_evaluated_at NULLS FIRST,r.created_at LIMIT 100`);let opened=0;
 for(const r of rules.rows){const cfg=r.config;if(!cfg.active)continue;const period=cfg.startsAt&&cfg.endsAt?{startsAt:cfg.startsAt,endsAt:cfg.endsAt}:metricPeriod('mtd',cfg.timezone||'UTC',now);if(Date.parse(period.endsAt)<now.getTime()-86400000)continue;
 const result=await queryMetric(pool,{metricId:r.metric_id,version:r.version,...period,dimensions:cfg.dimensions});if(result.quality!=='complete'||result.value===null||Number(['mean','ratio'].includes(result.metric.kind)?result.denominator:result.count)<Number(cfg.minimumCount||1)){await pool.query('INSERT INTO metric_alert_evaluations(rule_id,breach_since,last_evaluated_at) VALUES($1,NULL,$2) ON CONFLICT(rule_id) DO UPDATE SET breach_since=NULL,last_evaluated_at=EXCLUDED.last_evaluated_at',[r.id,now]);continue;}
 await transaction(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`alert:${r.id}`]);const compare=await c.query('SELECT $1::numeric < $2::numeric below,$1::numeric > $2::numeric above',[result.value,cfg.threshold]);const breach=cfg.operator==='below'?compare.rows[0].below:compare.rows[0].above;const old=(await c.query("SELECT * FROM metric_alert_episodes WHERE rule_id=$1 AND status='open'",[r.id])).rows[0];
 const state=(await c.query('SELECT * FROM metric_alert_evaluations WHERE rule_id=$1',[r.id])).rows[0];const breachSince=breach?(state?.breach_since??now):null;await c.query('INSERT INTO metric_alert_evaluations(rule_id,breach_since,last_evaluated_at) VALUES($1,$2,$3) ON CONFLICT(rule_id) DO UPDATE SET breach_since=EXCLUDED.breach_since,last_evaluated_at=EXCLUDED.last_evaluated_at',[r.id,breachSince,now]);
 const sustained=!breach||now.getTime()-new Date(breachSince).getTime()>=Number(cfg.sustainedSeconds??0)*1000;
 const recent=(await c.query('SELECT recovered_at FROM metric_alert_episodes WHERE rule_id=$1 AND recovered_at IS NOT NULL ORDER BY recovered_at DESC LIMIT 1',[r.id])).rows[0];const cooled=!recent||now.getTime()-new Date(recent.recovered_at).getTime()>=Number(cfg.cooldownSeconds??0)*1000;
 if(breach&&sustained&&cooled){if(old)await c.query('UPDATE metric_alert_episodes SET updated_at=$2,value=$3 WHERE id=$1',[old.id,now,result.value]);else{const snapshotId=uuid();await c.query('INSERT INTO metric_query_snapshots(id,metric_id,query,result) VALUES($1,$2,$3,$4)',[snapshotId,r.metric_id,period,result]);await c.query("INSERT INTO metric_alert_episodes(id,rule_id,metric_id,status,opened_at,updated_at,value,snapshot_id) VALUES($1,$2,$3,'open',$4,$4,$5,$6)",[uuid(),r.id,r.metric_id,now,result.value,snapshotId]);opened++;}}
 else if(!breach&&old)await c.query("UPDATE metric_alert_episodes SET status='recovered',updated_at=$2,recovered_at=$2,value=$3 WHERE id=$1",[old.id,now,result.value]);});
 }return{opened};}
