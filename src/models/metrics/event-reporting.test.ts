import {describe,it,expect} from 'vitest';
import {libraryInput} from './library';
import {eventFunnelPlot} from './event-funnel-plot';
import {chartIssue} from './visualization';
const query={sourceId:'00000000-0000-7000-8000-000000000001',datasetKey:'app',schemaVersion:1,startsAt:'2026-11-10T00:00:00Z',endsAt:'2026-11-15T00:00:00Z',unit:'person' as const,windowSeconds:86400,steps:[{name:'open'},{name:'signup'}]};
const input={name:'Activation',kind:'query',visibility:'private',config:{eventFunnel:{query,period:'fixed'}}};
describe('saved behavior funnels',()=>{
 it('retains typed property filters and supplies a funnel chart',()=>{const item=libraryInput({...input,config:{eventFunnel:{query:{...query,steps:[{name:'open',properties:{paid:false}},{name:'signup'}]},period:'today'}}});expect(item.config.eventFunnel?.query.steps[0].properties).toEqual({paid:false});expect(item.config.chart).toMatchObject({kind:'funnel',stageTotals:true});});
 it('rejects mixed query sources, invalid windows and misleading charts',()=>{expect(()=>libraryInput({...input,config:{...input.config,query:{}}})).toThrow(/one query/);expect(()=>libraryInput({...input,config:{eventFunnel:{query:{...query,windowSeconds:0},period:'fixed'}}})).toThrow(/Conversion window/);expect(()=>libraryInput({...input,config:{...input.config,chart:{kind:'pie'}}})).toThrow(/funnel chart/);});
 it('preserves zero stages and order without summing distinct cohorts',()=>{const data=eventFunnelPlot({steps:[{name:'open',count:10},{name:'signup',count:0}],recomputing:true},query);expect(data.rows.map(r=>r.value)).toEqual(['10','0']);expect(data.additive).toBe(false);expect(chartIssue(data,{kind:'funnel',stageTotals:true})).toBeUndefined();expect(data.notes.join(' ')).toMatch(/provisional/);});
});
