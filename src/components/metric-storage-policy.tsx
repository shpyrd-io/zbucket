'use client';
import {useState} from 'react';
import {Input} from '@shpyrd/ui/components/input';
import {SelectControl} from './select-control';
import {baseResolutions,estimateStates,type StoragePolicy} from '@/models/metrics/resolution';
export function MetricStoragePolicy({initial}:{initial?:StoragePolicy}){
 const [enabled,setEnabled]=useState(!!initial),[policy,setPolicy]=useState<StoragePolicy>(initial??{baseResolution:'hour',baseRetentionDays:30,hourRetentionDays:30,dayRetentionDays:730,rawRetentionDays:null}),[series,setSeries]=useState(1000);
 const estimate=estimateStates(policy,series);
 return <fieldset className="grid gap-3 rounded-md border p-3"><legend className="px-1 text-sm font-medium">Storage and resolution</legend>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Use a resolution policy</label><input type="hidden" name="storagePolicy" value={enabled?JSON.stringify(policy):''}/>
 {enabled&&<><label>Base resolution<SelectControl value={policy.baseResolution} onValueChange={v=>setPolicy({...policy,baseResolution:v as StoragePolicy['baseResolution'],...(v==='hour'?{hourRetentionDays:policy.baseRetentionDays}:v==='day'?{baseRetentionDays:policy.dayRetentionDays,hourRetentionDays:policy.dayRetentionDays}:{})})}>{baseResolutions.map(v=><option key={v} value={v}>{v.replaceAll('_',' ')}</option>)}</SelectControl></label>
 <div className="grid grid-cols-2 gap-3">{(['baseRetentionDays','hourRetentionDays','dayRetentionDays'] as const).filter(k=>policy.baseResolution==='day'?k==='dayRetentionDays':policy.baseResolution==='hour'?k!=='baseRetentionDays':true).map(k=><label key={k}>{k==='baseRetentionDays'?'Base retention':k==='hourRetentionDays'?'Hourly retention':'Daily retention'} (days)<Input type="number" min="1" max="36500" value={policy[k]} onChange={e=>setPolicy({...policy,[k]:Number(e.target.value),...(policy.baseResolution==='day'?{baseRetentionDays:Number(e.target.value),hourRetentionDays:Number(e.target.value),dayRetentionDays:Number(e.target.value)}:policy.baseResolution==='hour'&&k!=='dayRetentionDays'?{baseRetentionDays:Number(e.target.value),hourRetentionDays:Number(e.target.value)}:{})})}/></label>)}
 <label>Raw retention (days)<Input type="number" min="1" max="36500" placeholder="Keep indefinitely" value={policy.rawRetentionDays??''} onChange={e=>setPolicy({...policy,rawRetentionDays:e.target.value?Number(e.target.value):null})}/></label></div>
 <p className="text-xs text-muted-foreground">Raw expiry removes original detail and closes its correction window. Saved evidence remains. Retention must increase from base to hour to day. Exact distinct and p95 require raw detail and do not support this policy.</p>
 <label>Estimated active series<Input type="number" min="1" max="100000" value={series} onChange={e=>setSeries(Number(e.target.value))}/></label>
 <p className="text-xs text-muted-foreground">Approximately {Number.isFinite(estimate.total)?Math.round(estimate.total).toLocaleString():'—'} retained aggregate states at full density. Excludes raw data, indexes, receipts and revisions. A series is one existing combination of dimension values.</p></>}
 </fieldset>;
}
