'use client';
import {Input} from '@shpyrd/ui/components/input';
import {Textarea} from '@shpyrd/ui/components/textarea';
import {SelectControl} from './select-control';
import {periods,type SavedEventFunnel} from '@/models/metrics/library';
export function EventFunnelControls({value,onChange}:{value:SavedEventFunnel;onChange:(v:SavedEventFunnel)=>void}){
 const q=value.query;
 return <div className="grid gap-3">
  <p className="text-sm">Ordered event conversion · {q.datasetKey} · v{q.schemaVersion}. Each person or account is counted once per report.</p>
  <label>Reporting period<SelectControl value={value.period} onValueChange={period=>onChange({...value,period:period as SavedEventFunnel['period']})}>{periods.filter(p=>p!=='last_2_years').map(p=><option key={p} value={p}>{p.replaceAll('_',' ')}</option>)}</SelectControl></label>
  {value.period==='fixed'&&<><label>From (UTC)<Input type="datetime-local" value={q.startsAt.slice(0,16)} onChange={e=>onChange({...value,query:{...q,startsAt:e.target.value?new Date(e.target.value+'Z').toISOString():''}})}/></label><label>Until (UTC, exclusive)<Input type="datetime-local" value={q.endsAt.slice(0,16)} onChange={e=>onChange({...value,query:{...q,endsAt:e.target.value?new Date(e.target.value+'Z').toISOString():''}})}/></label></>}
  <label>Calendar timezone<Input value={value.timezone??'UTC'} onChange={e=>onChange({...value,timezone:e.target.value})}/></label>
  <label>Compare with<SelectControl value={value.compare??'none'} onValueChange={compare=>onChange({...value,compare:compare as SavedEventFunnel['compare']})}><option value="none">No comparison</option><option value="previous_period">Previous equal-duration period</option><option value="previous_year">Same dates last year</option><option value="custom">Custom period</option></SelectControl></label>
  {value.compare==='custom'&&<><label>Comparison from (UTC)<Input type="datetime-local" value={value.compareStartsAt?.slice(0,16)??''} onChange={e=>onChange({...value,compareStartsAt:e.target.value?new Date(e.target.value+'Z').toISOString():''})}/></label><label>Comparison until (UTC, exclusive)<Input type="datetime-local" value={value.compareEndsAt?.slice(0,16)??''} onChange={e=>onChange({...value,compareEndsAt:e.target.value?new Date(e.target.value+'Z').toISOString():''})}/></label></>}
  <label>Ordered steps (one event name per line)<Textarea rows={5} value={q.steps.map(s=>s.name).join('\n')} onChange={e=>onChange({...value,query:{...q,steps:e.target.value.split('\n').map((name,i)=>({...q.steps[i],name}))}})}/></label>
  <label>Count unique<SelectControl value={q.unit} onValueChange={unit=>onChange({...value,query:{...q,unit:unit as 'person'|'account'}})}><option value="person">People</option><option value="account">Accounts</option></SelectControl></label>
  <label>Conversion window (hours)<Input type="number" min="0.001" max="2160" step="any" value={q.windowSeconds/3600} onChange={e=>onChange({...value,query:{...q,windowSeconds:Math.round(Number(e.target.value)*3600)}})}/></label>
  <p className="text-xs text-muted-foreground">All steps must occur within the selected period. Reports run in background and reuse completed results. Rolling periods refresh on five-minute boundaries. Daily event counts remain a separate projection.</p>
 </div>;
}
