import {database} from '../src/server/database';
import {setFunnelPreprocessing} from '../src/server/metrics/funnel-projections';
const mode=process.argv[2];
if(!['--enable','--disable','--status'].includes(mode)){console.error('Usage: npm run funnels:preprocessing -- --enable | --disable | --status');process.exit(1);}
const pool=await database();try{
 console.log(JSON.stringify(mode==='--status'?(await pool.query('SELECT enabled FROM metric_funnel_preprocessing WHERE id')).rows[0]:await setFunnelPreprocessing(pool,mode==='--enable')));
}finally{await pool.end();}
