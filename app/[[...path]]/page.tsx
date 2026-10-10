import {Application} from '@/screens/application';
import {notFound,redirect} from 'next/navigation';
import type {KnowledgeIdentity} from '@/models/knowledge-links';
export default async function Page({params,searchParams}:{params:Promise<{path?:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {path=[]}=await params;
 if(!path.length)redirect('/metrics');
 if(!['metrics','knowledge','integrations'].includes(path[0]))notFound();
 let knowledgeIdentity:KnowledgeIdentity|undefined;
 if(path[0]==='knowledge'){
  if(path.length>=3){
   // Next's catch-all route supplies encoded path segments; decode exactly once.
   try{knowledgeIdentity={collection:decodeURIComponent(path[1]),key:path.slice(2).map(segment=>decodeURIComponent(segment)).join('/')};}
   catch{notFound();}
  }
  else if(path.length===1){
   const query=await searchParams;
   if(query.key!==undefined){
    if(typeof query.collection!=='string'||!query.collection||typeof query.key!=='string'||!query.key)notFound();
    knowledgeIdentity={collection:query.collection,key:query.key};
   }
  }
 }else if(path.length>2)notFound();
 return <Application page={path[0]} selectedId={knowledgeIdentity?undefined:path[1]} knowledgeIdentity={knowledgeIdentity}/>;
}
