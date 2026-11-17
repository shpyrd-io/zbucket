'use client';
import {useState} from 'react';
import Link from 'next/link';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {Button} from '@shpyrd/ui/components/button';
import {Input} from '@shpyrd/ui/components/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@shpyrd/ui/components/dialog';
import {get,post} from '@/api/zbucket';
import type {EventDataset} from '@/models/metrics/events';
import type {Metric} from '@/models/metrics/types';
type Job={metric_id:string;key:string;source_id:string;dataset_key:string;status:string;scanned:string;inserted:string;skipped:string;last_error:string|null};
export function DailyEventProcessing({dataset}:{dataset:EventDataset}){
 const [open,setOpen]=useState(false),[key,setKey]=useState(''),[name,setName]=useState('Daily app events'),[history,setHistory]=useState(true);const qc=useQueryClient();
 const jobs=useQuery({queryKey:['event-processing'],queryFn:()=>get<{jobs:Job[]}>('metrics/event-processing'),refetchInterval:5000});
 const create=useMutation({mutationFn:()=>post<{metric:Metric}>('metrics/event-processing',{sourceId:dataset.sourceId,datasetKey:dataset.datasetKey,schemaVersion:dataset.schemaVersion,key,name,includeHistory:history}),onSuccess:()=>{void qc.invalidateQueries({queryKey:['event-processing']});void qc.invalidateQueries({queryKey:['metrics']});setOpen(false);}});
 const matching=jobs.data?.jobs.filter(j=>j.source_id===dataset.sourceId&&j.dataset_key===dataset.datasetKey)??[];
 return <section className="integration-card mb-4"><div className="flex flex-wrap gap-3 items-center"><Button variant="outline" onClick={()=>{setKey(dataset.datasetKey.replace(/[^a-zA-Z0-9_]/g,'_')+'_daily_events');setOpen(true);}}>Process events by day</Button><p className="text-sm text-muted-foreground">Create daily occurrence counts for Metrics explorer. New events are processed automatically by the worker.</p></div>{matching.map(j=><p key={j.metric_id} className="text-sm mt-2"><Link className="table-link" href={`/metrics/${j.metric_id}`}>{j.key} → Metrics explorer</Link> · History: {j.status} · {j.scanned} scanned · {j.inserted} added · {j.skipped} skipped or already counted{j.last_error&&<span role="alert"> · Retrying: {j.last_error}</span>}</p>)}{jobs.error&&<p role="alert">{jobs.error.message}</p>}<Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Process events by day</DialogTitle><DialogDescription>Create an immutable count metric grouped by action, using UTC calendar days.</DialogDescription></DialogHeader><form className="grid gap-3" onSubmit={e=>{e.preventDefault();create.mutate();}}><label>Metric key<Input required value={key} onChange={e=>setKey(e.target.value)}/></label><label>Name<Input required value={name} onChange={e=>setName(e.target.value)}/></label><label className="flex gap-2 items-center"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>Also process retained history in the background</label><p className="text-sm text-muted-foreground">The worker processes batches and resumes after a restart. Only retained originals can be recovered. All dataset versions with the same action field are included. This grants this integration read/publish access to the new metric. Event occurrences are not unique-person funnel conversions.</p>{create.error&&<p role="alert">{create.error.message}</p>}<Button disabled={create.isPending}>{create.isPending?'Enabling…':'Enable daily processing'}</Button></form></DialogContent></Dialog></section>;
}
