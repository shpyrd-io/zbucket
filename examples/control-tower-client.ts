import {WarehouseClient} from '../src/client/warehouse';
// Run from a consuming backend. Put both values in that application's secrets/config.
const client=new WarehouseClient(process.env.WAREHOUSE_URL!,process.env.WAREHOUSE_TOKEN!);
const observedAt=new Date().toISOString();
console.log(await client.measurements([{measurementId:`cash:account-001:${observedAt}`,metricKey:'cash_balance_brl',observedAt,value:'125000.50',unit:'BRL',dimensions:{account_id:'account-001'}}]));
console.log(await client.query({metricId:'cash_balance_brl',startsAt:'2026-10-01T00:00:00Z',endsAt:'2026-11-01T00:00:00Z',interval:'hour',aggregation:'sum'}));
console.log(await client.search('How do we collect bank balances?','warehouse'));
