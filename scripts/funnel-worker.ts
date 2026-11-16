import {processFunnelProjection,reconcileFunnelSubscriptions,cleanFunnelProjections} from '../src/server/metrics/funnel-projections';
import {prewarmFunnels} from '../src/server/metrics/funnel-prewarming';
import {database} from '../src/server/database';
import {processFunnelRun,cleanFunnelRuns} from '../src/server/metrics/funnel-runs';
const pool=await database();let stopping=false,lastCleanup=0;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){try{if(Date.now()-lastCleanup>60000){await reconcileFunnelSubscriptions(pool);await cleanFunnelRuns(pool);await cleanFunnelProjections(pool);await prewarmFunnels(pool);lastCleanup=Date.now();}const projected=await processFunnelProjection(pool);const worked=await processFunnelRun(pool)||projected;if(!worked)await new Promise(r=>setTimeout(r,1000));}catch(error){console.error('Funnel worker:',error instanceof Error?error.message:'Processing failed');await new Promise(r=>setTimeout(r,3000));}}
await pool.end();
