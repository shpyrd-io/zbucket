import {database} from '../src/server/database';
import {readKnowledgeDirectory} from '../src/server/knowledge-files';
import {saveDocument} from '../src/server/knowledge';
import type {Principal} from '../src/server/access';
import path from 'node:path';
const root=path.resolve(process.argv.find(a=>a.startsWith('--dir='))?.slice(6)??'docs'),files=await readKnowledgeDirectory(root,{strict:true});
if(process.argv.includes('--dry-run')){console.log(JSON.stringify(files.map(f=>({key:f.metadata.id,collection:f.metadata.collection,title:f.metadata.title})),null,2));process.exit(0);}
const pool=await database(),actor:Principal={kind:'user',id:'00000000-0000-7000-8000-000000000001',name:'Documentation importer',admin:true};let count=0;
try{for(const f of files){if(!f.metadata.index)continue;const m=f.metadata;await pool.query('INSERT INTO knowledge_collections VALUES($1,$2) ON CONFLICT DO NOTHING',[m.collection,m.collection]);const old=(await pool.query('SELECT id,revision FROM knowledge_documents WHERE collection=$1 AND key=$2',[m.collection,m.id])).rows[0];await saveDocument(pool,actor,{...old,collection:m.collection,key:m.id,title:m.title,content:f.content,category:m.category,tags:m.tags,source_type:m.sourceType,reason:'Directory import: '+f.relative});count++;}console.log(`Imported ${count} documents. Vector indexing runs in the worker when Voyage is configured.`);}finally{await pool.end();}
