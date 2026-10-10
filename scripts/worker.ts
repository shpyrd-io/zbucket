import {database} from '../src/server/database';
import {processMetricBatch} from '../src/server/metrics/worker';
import {maintainMetricRetention} from '../src/server/metrics/rollups';
import {indexOne} from '../src/server/knowledge';
const pool=await database();let stopping=false,lastRetention=0;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){try{const n=await processMetricBatch(pool);await indexOne(pool);if(Date.now()-lastRetention>60000){await maintainMetricRetention(pool);lastRetention=Date.now();}if(!n)await new Promise(r=>setTimeout(r,1000));}catch(e){console.error('Warehouse worker:',e instanceof Error?e.message:'Failed');await new Promise(r=>setTimeout(r,3000));}}await pool.end();
