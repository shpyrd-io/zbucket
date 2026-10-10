import type pg from 'pg';
import type {KnowledgeIdentity} from '@/models/knowledge-links';
import {v7 as uuid} from 'uuid';
import {check,object,text,canonical} from '@/models/metrics/validation';
import {transaction} from './db/metrics';
import {admin,audit,type Principal} from './access';
export type Document={id:string;collection:string;key:string;title:string;content:string;category:string;tags:string[];source_type:string;source_url:string;revision:number;active:boolean;owner_app_id:string|null;index_status:string;updated_at:string};
export function chunkText(value:string,max=2200,overlap=220){const s=value.replace(/\r\n/g,'\n').trim(),chunks:string[]=[];let start=0;while(start<s.length){let end=Math.min(start+max,s.length);if(end<s.length){const boundary=s.lastIndexOf('\n',end);if(boundary>start+max/2)end=boundary;}chunks.push(s.slice(start,end));if(end===s.length)break;start=Math.max(start+1,end-overlap);}return chunks;}
const model=()=>process.env.VOYAGE_MODEL||'voyage-4';
export async function embed(texts:string[],type:'query'|'document'){
 check(process.env.VOYAGE_API_KEY,'Semantic search is not configured.',503);
 const r=await fetch('https://api.voyageai.com/v1/embeddings',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${process.env.VOYAGE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:model(),input:texts,input_type:type,output_dimension:1024,output_dtype:'float',truncation:false})});
 check(r.ok,`Embedding provider returned HTTP ${r.status}.`,502);const data=await r.json();const vectors=(data.data??[]).sort((a:{index:number},b:{index:number})=>a.index-b.index).map((v:{embedding:number[]})=>v.embedding) as number[][];
 check(vectors.length===texts.length&&vectors.every(v=>Array.isArray(v)&&v.length===1024&&v.every(Number.isFinite)),'Invalid embedding response.',502);return vectors;
}
function readable(p:Principal){return p.kind==='user'?null:p.permissions.knowledge.readCollections;}
function writable(p:Principal,collection:string,old?:Document){if(p.kind==='user'){admin(p);return;}check(p.permissions.knowledge.writeCollections.includes(collection),'Collection write access denied.',403);check(!old||old.owner_app_id===p.id,'This document belongs to another publisher.',403);}
export async function documentGet(pool:pg.Pool,p:Principal,reference:string|KnowledgeIdentity,history=false){
 if(history&&p.kind==='integration')check(p.permissions.knowledge.history,'Document history access denied.',403);
 const rows=typeof reference==='string'
  ? await pool.query('SELECT * FROM knowledge_documents WHERE id::text=$1 AND ($2::text[] IS NULL OR collection=ANY($2))',[reference,readable(p)])
  : await pool.query('SELECT * FROM knowledge_documents WHERE collection=$1 AND key=$2 AND ($3::text[] IS NULL OR collection=ANY($3))',[reference.collection,reference.key,readable(p)]);
 const d=rows.rows[0] as Document|undefined;check(d,'Document not found.',404);
 if(history)return {document:d,versions:(await pool.query('SELECT revision,document,reason,created_at FROM knowledge_revisions WHERE document_id=$1 ORDER BY revision DESC',[d.id])).rows};return d;
}
export async function knowledgeList(pool:pg.Pool,p:Principal,params:URLSearchParams){
 const allowed=readable(p),collection=params.get('collection')||null,q=(params.get('q')||'').slice(0,2000).trim(),after=params.get('after')||'';
 if(collection&&allowed)check(allowed.includes(collection),'Collection access denied.',403);
 const collections=(await pool.query('SELECT * FROM knowledge_collections WHERE $1::text[] IS NULL OR key=ANY($1) ORDER BY name',[allowed])).rows;
 if(!q){const rows=(await pool.query(`SELECT * FROM knowledge_documents WHERE active AND ($1::text[] IS NULL OR collection=ANY($1)) AND ($2::text IS NULL OR collection=$2) AND id::text>$3 ORDER BY id LIMIT 51`,[allowed,collection,after])).rows;return {documents:rows.slice(0,50),collections,nextCursor:rows.length>50?rows[49].id:undefined,mode:'catalog'};}
 if(p.kind==='integration')check(p.permissions.knowledge.search,'Knowledge search access denied.',403);
 if(allowed?.length===0)return {documents:[],collections,mode:'lexical'};
 const lexical=(await pool.query(`SELECT d.*,ts_rank_cd(to_tsvector('simple',d.title||' '||d.content),websearch_to_tsquery('simple',$3)) rank FROM knowledge_documents d WHERE d.active AND ($1::text[] IS NULL OR d.collection=ANY($1)) AND ($2::text IS NULL OR d.collection=$2) AND (to_tsvector('simple',d.title||' '||d.content) @@ websearch_to_tsquery('simple',$3) OR d.title ILIKE '%'||$3||'%') ORDER BY rank DESC,d.id LIMIT 100`,[allowed,collection,q])).rows;
 const ranked=new Map<string,{d:Document;score:number}>();lexical.forEach((d,i)=>ranked.set(d.id,{d,score:1/(60+i+1)}));let mode='lexical',notice:string|undefined;
 if(process.env.VOYAGE_API_KEY){try{const [v]=await embed([q],'query');const semantic=(await pool.query(`SELECT DISTINCT ON(id) * FROM (SELECT d.*,c.content snippet,c.embedding <=> $3::vector distance FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.revision=c.revision WHERE d.active AND c.embedding IS NOT NULL AND c.embedding_model=$4 AND ($1::text[] IS NULL OR d.collection=ANY($1)) AND ($2::text IS NULL OR d.collection=$2) ORDER BY distance LIMIT 200) candidates ORDER BY id,distance`,[allowed,collection,JSON.stringify(v),model()])).rows.sort((a,b)=>a.distance-b.distance);semantic.forEach((d,i)=>{const old=ranked.get(d.id);ranked.set(d.id,{d:old?.d??d,score:(old?.score??0)+1/(60+i+1)});});mode='hybrid';}catch{notice='Semantic search unavailable. Showing text matches.';}}
 return {documents:[...ranked.values()].sort((a,b)=>b.score-a.score).slice(0,50).map(r=>r.d),collections,mode,notice};
}
export async function saveDocument(pool:pg.Pool,p:Principal,input:unknown){const b=object(input);return transaction(pool,async c=>{
 const action=String(b.action??'save');let old:Document|undefined;
 if(b.id){old=(await c.query('SELECT * FROM knowledge_documents WHERE id=$1',[b.id])).rows[0];check(old,'Document not found.',404);}
 const collection=old?.collection??text(b.collection,'Collection',80),key=old?.key??text(b.key,'Document key',200);writable(p,collection,old);
 check((await c.query('SELECT 1 FROM knowledge_collections WHERE key=$1',[collection])).rowCount,'Collection not found.',404);
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[collection+':'+key]);
 old=(await c.query('SELECT * FROM knowledge_documents WHERE collection=$1 AND key=$2 FOR UPDATE',[collection,key])).rows[0];writable(p,collection,old);
 let data=b;
 if(action==='restore'){check(old,'Document not found.',404);if(p.kind==='integration')check(p.permissions.knowledge.history,'History access denied.',403);const r=(await c.query('SELECT document FROM knowledge_revisions WHERE document_id=$1 AND revision=$2',[old.id,b.restoreRevision])).rows[0];check(r,'Revision not found.',404);data={...r.document,active:true};}
 if(action==='archive'){check(old,'Document not found.',404);if(p.kind==='integration')check(p.permissions.knowledge.archive,'Archive permission required.',403);data={...old,active:false};}
 check(['save','restore','archive'].includes(action),'Unknown document action.');
 const content=text(data.content,'Markdown content',200000),title=text(data.title,'Title',300),category=String(data.category??'').slice(0,120),sourceType=String(data.source_type??'reference'),sourceUrl=String(data.source_url??'');
 check(['reference','handbook','runbook','specification','note'].includes(sourceType),'Invalid source type.');check(!sourceUrl||/^https?:\/\//.test(sourceUrl),'Source URL must use HTTP or HTTPS.');
 const tags=data.tags??[];check(Array.isArray(tags)&&tags.length<=30&&tags.every(t=>typeof t==='string'&&t.length<=80),'Invalid tags.');
 const values={title,content,category,tags,source_type:sourceType,source_url:sourceUrl,active:data.active!==false};
 if(old){const same=Object.entries(values).every(([k,v])=>canonical(v)===canonical(old![k as keyof Document]));if(same&&action==='save')return old;check(old.revision===b.revision,'Document changed. Supply its current revision.',409);}
 const id=old?.id??uuid(),revision=(old?.revision??0)+1;
 const d=(await c.query(`INSERT INTO knowledge_documents(id,collection,key,title,content,category,tags,source_type,source_url,revision,active,owner_app_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,category=EXCLUDED.category,tags=EXCLUDED.tags,source_type=EXCLUDED.source_type,source_url=EXCLUDED.source_url,revision=EXCLUDED.revision,active=EXCLUDED.active,index_status='pending',index_attempts=0,index_error=NULL,updated_at=now() RETURNING *`,[id,collection,key,title,content,category,JSON.stringify(tags),sourceType,sourceUrl,revision,values.active,old?.owner_app_id??(p.kind==='integration'?p.id:null)])).rows[0] as Document;
 await c.query('INSERT INTO knowledge_revisions(document_id,revision,document,actor_id,reason) VALUES($1,$2,$3,$4,$5)',[id,revision,d,p.id,String(b.reason??action).slice(0,2000)]);
 await c.query('DELETE FROM knowledge_revisions WHERE document_id=$1 AND revision<=$2',[id,revision-21]);
 await c.query('DELETE FROM knowledge_chunks WHERE document_id=$1',[id]);
 const chunks=chunkText(title+'\n\n'+content);await c.query(`INSERT INTO knowledge_chunks(document_id,revision,ordinal,content) SELECT $1,$2,ord::int-1,value FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY a(value,ord)`,[id,revision,JSON.stringify(chunks)]);
 await audit(c,p,'knowledge_'+action,id);return d;
});}
export async function indexOne(pool:pg.Pool,embedder=embed){if(!process.env.VOYAGE_API_KEY&&embedder===embed)return 0;const c=await pool.connect();let id:string|undefined,revision:number|undefined;
 try{const jobs=(await c.query("SELECT id FROM knowledge_documents WHERE active AND index_status IN ('pending','retrying') AND index_attempts<3 ORDER BY updated_at LIMIT 10")).rows;for(const job of jobs){if((await c.query('SELECT pg_try_advisory_lock(hashtext($1)) locked',['knowledge:'+job.id])).rows[0].locked){id=job.id;break;}}if(!id)return 0;
 const d=(await c.query('SELECT * FROM knowledge_documents WHERE id=$1',[id])).rows[0];if(!d.active||!['pending','retrying'].includes(d.index_status))return 0;revision=d.revision;
 const chunks=(await c.query('SELECT * FROM knowledge_chunks WHERE document_id=$1 ORDER BY ordinal',[id])).rows;const vectors:number[][]=[];for(let i=0;i<chunks.length;i+=16)vectors.push(...await embedder(chunks.slice(i,i+16).map(r=>r.content),'document'));
 await c.query('BEGIN');const current=(await c.query('SELECT revision,active FROM knowledge_documents WHERE id=$1 FOR UPDATE',[id])).rows[0];if(current.revision===d.revision&&current.active){for(let i=0;i<chunks.length;i++)await c.query('UPDATE knowledge_chunks SET embedding=$3::vector,embedding_model=$4 WHERE document_id=$1 AND ordinal=$2',[id,i,JSON.stringify(vectors[i]),model()]);await c.query("UPDATE knowledge_documents SET index_status='indexed',index_error=NULL WHERE id=$1",[id]);}await c.query('COMMIT');return 1;
 }catch{await c.query('ROLLBACK');if(id)await c.query("UPDATE knowledge_documents SET index_attempts=index_attempts+1,index_status=CASE WHEN index_attempts>=2 THEN 'failed' ELSE 'retrying' END,index_error='Embedding request failed. Check provider configuration.' WHERE id=$1 AND revision=$2",[id,revision]);return 0;}finally{if(id)await c.query('SELECT pg_advisory_unlock(hashtext($1))',['knowledge:'+id]);c.release();}}
