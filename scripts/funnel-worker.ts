import {database} from '../src/server/database';
import {processFunnelRun,cleanFunnelRuns} from '../src/server/metrics/funnel-runs';
const pool=await database();let stopping=false,lastCleanup=0;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){try{const worked=await processFunnelRun(pool);if(Date.now()-lastCleanup>60000){await cleanFunnelRuns(pool);lastCleanup=Date.now();}if(!worked)await new Promise(r=>setTimeout(r,1000));}catch(error){console.error('Funnel worker:',error instanceof Error?error.message:'Processing failed');await new Promise(r=>setTimeout(r,3000));}}
await pool.end();
