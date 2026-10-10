'use client';
import {useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Button} from '@shpyrd/ui/components/button';
import {Input} from '@shpyrd/ui/components/input';
import {Textarea} from '@shpyrd/ui/components/textarea';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@shpyrd/ui/components/dialog';
import {post} from '@/api/warehouse';
import type {Metric} from '@/models/metrics/types';
import type {PurgePreview, PurgeResult} from '@/models/metrics/purge';

const localDate=(iso:string)=>{
  const date=new Date(iso);
  return Number.isFinite(+date)?new Date(+date-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';
};
const labels:Record<keyof PurgePreview['counts'],string>={
  measurements:'Retained raw measurements',records:'Record identities',pendingRecords:'Pending record revisions',
  aggregateBuckets:'Aggregate buckets affected',coverageIntervals:'Coverage intervals affected',dimensionCombinations:'Dimension combinations affected',
};
export function MetricPurge({metric,startsAt,endsAt,dimensions}:{metric:Metric;startsAt:string;endsAt:string;dimensions:Record<string,string>}) {
  const qc=useQueryClient();
  const [open,setOpen]=useState(false),[period,setPeriod]=useState(true),[start,setStart]=useState(''),[end,setEnd]=useState('');
  const [filters,setFilters]=useState<Record<string,string>>({}),[preview,setPreview]=useState<PurgePreview|null>(null);
  const [confirmation,setConfirmation]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[result,setResult]=useState<PurgeResult|null>(null);
  const running=useRef(false),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function run(execute:boolean, form?:FormData) {
    if(running.current)return;
    running.current=true;setBusy(true);setError('');
    try {
      if(execute&&preview){
        const r=await post<PurgeResult>(`metrics/purge/${metric.id}`,{...preview.scope,fingerprint:preview.fingerprint,confirmationKey:confirmation,reason});
        setResult(r);setOpen(false);
        for(const key of ['metrics','metric-query','metric-detail','metric-data','metric-sources','metric-library-run','metric-distribution'])void qc.invalidateQueries({queryKey:[key]});
      }else{
        // Read native date inputs at submission so the preview always matches the visible fields.
        const selectedStart=String(form?.get('startsAt')??start),selectedEnd=String(form?.get('endsAt')??end);
        setStart(selectedStart);setEnd(selectedEnd);
        const scope={...(period?{startsAt:new Date(selectedStart).toISOString(),endsAt:new Date(selectedEnd).toISOString()}:{}),dimensions:Object.fromEntries(Object.entries(filters).filter(([,v])=>v!==''))};
        setPreview(await post<PurgePreview>(`metrics/purge-preview/${metric.id}`,scope));setConfirmation('');
      }
    }catch(e){setError(e instanceof Error?e.message:'Unable to clean up data.');}
    finally{running.current=false;setBusy(false);}
  }
  const show=()=>{setStart(localDate(startsAt));setEnd(localDate(endsAt));setPeriod(true);setFilters(dimensions);setPreview(null);setConfirmation('');setReason('');setError('');setOpen(true);};
  return <section className="my-5 rounded-lg border p-5 max-w-3xl">
    <h3 className="font-semibold">Data cleanup</h3>
    <p className="my-3 text-sm text-muted-foreground">Permanently remove observations by period, dimension value, or both. Aggregates are updated in the same operation. Only administrators can preview or execute a purge.</p>
    <Button variant="outline" onClick={show}>Purge data…</Button>
    {result&&<p role="status" className="mt-4 text-sm">Cleanup completed: {result.counts.measurements.toLocaleString()} retained measurements removed; {result.counts.aggregateBuckets.toLocaleString()} aggregate buckets updated. Recorded in Activity.</p>}
    <Dialog open={open} onOpenChange={v=>{if(!running.current)setOpen(v);}}><DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-auto"><DialogHeader>
      <DialogTitle>{preview?'Review data purge':'Purge metric data'}</DialogTitle>
      <DialogDescription>{metric.name} · {metric.key}</DialogDescription>
    </DialogHeader>
    {!preview?<form className="grid gap-4" onSubmit={e=>{e.preventDefault();void run(false,new FormData(e.currentTarget));}}>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={period} onChange={e=>setPeriod(e.target.checked)}/>Limit to a period</label>
      {period?<><div className="grid sm:grid-cols-2 gap-3"><label className="grid gap-2 text-sm">Start (inclusive)<Input name="startsAt" type="datetime-local" required value={start} onChange={e=>setStart(e.target.value)}/></label><label className="grid gap-2 text-sm">End (exclusive)<Input name="endsAt" type="datetime-local" required value={end} onChange={e=>setEnd(e.target.value)}/></label></div><p className="text-xs text-muted-foreground">Dates use your timezone: {zone}. Metric reporting timezone: {metric.timezone}.</p></>:<p className="text-sm">All time. Enter at least one dimension value below.</p>}
      {!!metric.dimensions.length&&<fieldset className="grid gap-3"><legend className="text-sm font-medium mb-2">Dimension values</legend><p className="text-xs text-muted-foreground">Exact matches. Filled fields are combined with AND; a period further narrows the selection. Blank fields include all values.</p>{metric.dimensions.map(key=><label key={key} className="grid gap-2 text-sm">{key}<Input value={filters[key]??''} placeholder="All values" onChange={e=>setFilters({...filters,[key]:e.target.value})}/></label>)}</fieldset>}
      <p className="text-sm text-muted-foreground">The preview makes no changes. It shows retained raw records and aggregate buckets separately.</p>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy||(!period&&!Object.values(filters).some(Boolean))}>{busy?'Preparing preview…':'Preview cleanup'}</Button>
    </form>:<form className="grid gap-4" onSubmit={e=>{e.preventDefault();void run(true);}}>
      <div className="rounded-md bg-muted p-3 text-sm grid gap-2"><p>{preview.scope.startsAt?`${preview.scope.startsAt} → ${preview.scope.endsAt} (end exclusive)`:'All time'}</p><p>{Object.entries(preview.scope.dimensions).map(([k,v])=>`${k} = ${v}`).join(' · ')||'All dimension values'}</p></div>
      <dl className="grid grid-cols-[1fr_auto] gap-2 text-sm">{(['measurements','aggregateBuckets','dimensionCombinations'] as const).map(key=><div key={key} className="contents"><dt className="text-muted-foreground">{labels[key]}</dt><dd className="tabular-nums font-medium">{preview.counts[key].toLocaleString()}</dd></div>)}</dl>
      <p className="text-sm">This cannot be undone. Saved snapshots keep their historical values.</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Processing and history details</summary><div className="mt-2 grid gap-2">
        <p>{preview.counts.records.toLocaleString()} record identities · {preview.counts.pendingRecords.toLocaleString()} pending revisions · {preview.counts.coverageIntervals.toLocaleString()} coverage intervals affected.</p>
        <p>Other metrics and this metric's definition are preserved. Purged record identities remain reserved for retry safety; use new record IDs to republish intentionally. Shared source events may retain their original payload for other metrics.</p>
      </div></details>
      {preview.scope.startsAt&&metric.kind==='latest'&&metric.missingData==='keep_previous'&&<p className="text-xs text-muted-foreground">Keep previous value is enabled. An earlier surviving reading can still appear in the cleaned period; this removes observations, not the carry-forward policy.</p>}
      <label className="grid gap-2 text-sm">Reason<Textarea required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <label className="grid gap-2 text-sm">Type {metric.key} to confirm<Input aria-label="Metric key confirmation" autoComplete="off" required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      {!Object.values(preview.counts).some(n=>n>0)&&<p className="text-sm">No matching retained data.</p>}
      <div className="flex flex-wrap gap-3 justify-between"><Button type="button" variant="outline" disabled={busy} onClick={()=>{setPreview(null);setError('');}}>Change filters / refresh preview</Button><Button type="submit" variant="destructive" disabled={busy||confirmation!==metric.key||!reason.trim()||!Object.values(preview.counts).some(n=>n>0)}>{busy?'Purging…':'Purge data permanently'}</Button></div>
    </form>}
    </DialogContent></Dialog>
  </section>;
}

export function MetricPurgeActivity({detail}:{detail:{purgeId?:string;reason?:string;scope?:PurgePreview['scope'];counts?:PurgePreview['counts']}}) {
  return <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted-foreground">Cleanup details</summary><div className="mt-3 grid gap-2">
    <p>{detail.reason}</p>
    {detail.scope&&<><p>{detail.scope.startsAt?`${detail.scope.startsAt} → ${detail.scope.endsAt} (end exclusive)`:'All time'}</p><p>{Object.entries(detail.scope.dimensions).map(([k,v])=>`${k} = ${v}`).join(' · ')||'All dimension values'}</p></>}
    {detail.counts&&<p>{detail.counts.measurements.toLocaleString()} retained measurements removed · {detail.counts.aggregateBuckets.toLocaleString()} aggregate buckets affected · {detail.counts.pendingRecords.toLocaleString()} pending record revisions</p>}
    <p className="text-xs text-muted-foreground">Purge ID: {detail.purgeId}</p>
  </div></details>;
}
