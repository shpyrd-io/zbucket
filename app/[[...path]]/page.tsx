import {Application} from '@/screens/application';
import {notFound,redirect} from 'next/navigation';
export default async function Page({params}:{params:Promise<{path?:string[]}>}){const{path=[]}=await params;if(!path.length)redirect('/metrics');if(!['metrics','knowledge','integrations'].includes(path[0])||path.length>2)notFound();return <Application page={path[0]} selectedId={path[1]}/>;}
