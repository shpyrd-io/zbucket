'use client';
import {useState} from 'react';
import Link from 'next/link';
import {Button} from '@shpyrd/ui/components/button';
import {Input} from '@shpyrd/ui/components/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@shpyrd/ui/components/dialog';
import {SelectControl} from './select-control';
import {EventFunnelControls} from './event-funnel-controls';
import {useSaveMetricLibrary} from '@/hooks/metric-library';
import type {SavedEventFunnel} from '@/models/metrics/library';
export function SaveEventFunnel({query}:{query:SavedEventFunnel['query']}){
 const [open,setOpen]=useState(false),[name,setName]=useState('Activation funnel'),[visibility,setVisibility]=useState<'private'|'company'>('private'),[value,setValue]=useState<SavedEventFunnel>({query,period:'fixed'}),[saved,setSaved]=useState('');const save=useSaveMetricLibrary();
 return <><Button variant="outline" onClick={()=>{setValue({query,period:'fixed'});setSaved('');setOpen(true);}}>Save funnel query</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Save event funnel</DialogTitle><DialogDescription>Reuse this ordered conversion query in views and dashboards.</DialogDescription></DialogHeader>{saved?<Link className="table-link" href={`/metrics?workspace=studio&item=${saved}`}>Open saved funnel →</Link>:<form className="grid gap-3 max-h-[70vh] overflow-auto" onSubmit={async e=>{e.preventDefault();const item=await save.mutateAsync({name,kind:'query',visibility,config:{eventFunnel:value,chart:{kind:'funnel',stageTotals:true,orientation:'horizontal'}}}).catch(()=>null);if(item)setSaved(item.id);}}><label>Name<Input required maxLength={160} value={name} onChange={e=>setName(e.target.value)}/></label><label>Visibility<SelectControl value={visibility} onValueChange={v=>setVisibility(v as typeof visibility)}><option value="private">Only me</option><option value="company">Company</option></SelectControl></label><EventFunnelControls value={value} onChange={setValue}/>{save.error&&<p role="alert">{save.error.message}</p>}<Button disabled={save.isPending}>Save query</Button></form>}</DialogContent></Dialog></>;
}
