import {database} from '@/server/database';
export async function GET(){try{await (await database()).query('SELECT 1');return Response.json({status:'ok',app:'warehouse'});}catch{return Response.json({status:'unavailable'},{status:503});}}
