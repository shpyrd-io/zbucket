import type pg from 'pg';
import {funnelPeriods} from '@/models/metrics/funnel-periods';
import type {SavedEventFunnel} from '@/models/metrics/library';
import {requestFunnelRun} from './funnel-runs';
/** Only bounded, saved periods are warmed; never enumerate all possible dates. */
export async function prewarmFunnels(pool:pg.Pool,now=new Date()){
 const items=(await pool.query(`SELECT m.id,m.owner_id,m.config FROM metric_funnel_subscriptions s JOIN metric_library m ON m.id=s.library_id JOIN metric_funnel_definitions d ON d.id=s.definition_id
 WHERE (SELECT enabled FROM metric_funnel_preprocessing WHERE id) AND d.initialized AND d.attempts<3 AND NOT EXISTS(SELECT 1 FROM metric_funnel_dirty WHERE definition_id=d.id)
 ORDER BY s.last_warmed_at NULLS FIRST,m.updated_at LIMIT 20`)).rows;
 for(const item of items){
  const saved=item.config.eventFunnel as SavedEventFunnel,bounds=funnelPeriods(saved,now),p={kind:'user' as const,id:item.owner_id,name:'Saved funnel refresh',admin:false};
  // A retained saved period may eventually expire. That item must not stop others.
  try{await requestFunnelRun(pool,p,{...saved.query,...bounds.current});if(bounds.comparison)await requestFunnelRun(pool,p,{...saved.query,...bounds.comparison});}
  catch(error){console.error('Funnel refresh:',error instanceof Error?error.message:'Period unavailable');}
  await pool.query('UPDATE metric_funnel_subscriptions SET last_warmed_at=now() WHERE library_id=$1',[item.id]);
 }
}
