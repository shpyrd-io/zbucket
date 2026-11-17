'use client';
import {useQuery} from '@tanstack/react-query';
import {get} from '@/api/zbucket';
import {Frame} from '@/shell/frame';
import {EventsScreen} from './events';
import {MetricsScreen} from './metrics';
import {KnowledgeScreen} from './knowledge';
import {IntegrationsScreen} from './integrations';
import type {KnowledgeIdentity} from '@/models/knowledge-links';
export function Application({page,selectedId,knowledgeIdentity}:{page:string;selectedId?:string;knowledgeIdentity?:KnowledgeIdentity}){const session=useQuery({queryKey:['session'],queryFn:()=>get<{id:string;name:string;admin:boolean}>('session')});if(session.error)return <p role="alert" className="p-8">{session.error.message}</p>;if(!session.data)return <p className="p-8">Opening zbucket…</p>;return <Frame page={page} name={session.data.name} admin={session.data.admin}>{page==='metrics'&&selectedId==='events'?<EventsScreen admin={session.data.admin}/>:page==='metrics'?<MetricsContent selectedId={selectedId} viewer={session.data}/>:page==='knowledge'?<KnowledgeScreen selectedId={selectedId} identity={knowledgeIdentity} admin={session.data.admin}/>:<IntegrationsScreen/>}</Frame>;}
function MetricsContent({selectedId,viewer}:{selectedId?:string;viewer:{id:string;name:string;admin:boolean}}){return MetricsScreen({selectedId,w:{viewer}}).content;}
