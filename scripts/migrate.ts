import {database} from '../src/server/database';
const pool=await database();await pool.end();console.log('Warehouse schema ready.');
