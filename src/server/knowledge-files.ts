import { readFile,readdir,stat,realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { requireRule } from '@/models/policy';
export type DocumentMetadata={id:string;title:string;sourceType:'reference'|'handbook';policyStatus:'approved'|'observed'|'proposed'|'historical';collection:string;category:string;tags:string[];index:boolean};
export type KnowledgeFile={relative:string;metadata:DocumentMetadata;content:string;hasFrontmatter:boolean};
export function parseKnowledgeFile(raw:string,relative:string,defaults:Partial<DocumentMetadata>={},strict=false):KnowledgeFile {
 const input=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 const hasFrontmatter=input.startsWith('---\n');let content=input,fields:Record<string,unknown>={};
 if(hasFrontmatter){
  const end=input.indexOf('\n---\n',4);requireRule(end>=0,'Unclosed front matter.',400);requireRule(end<16000,'Front matter exceeds 16 KB.',400);
  const document=parseDocument(input.slice(4,end),{uniqueKeys:true});requireRule(!document.errors.length&&!document.warnings.length,'Invalid YAML front matter.',400);
  let parsed:unknown;try{parsed=document.toJS({maxAliasCount:0});}catch{requireRule(false,'YAML aliases are not supported.',400);}
  requireRule(parsed&&typeof parsed==='object'&&!Array.isArray(parsed),'Front matter must be an object.',400);fields=parsed as Record<string,unknown>;content=input.slice(end+5).trim();
 }else requireRule(!strict,'YAML front matter is required.',400);
 const allowed=['id','title','sourceType','policyStatus','collection','category','tags','index'];requireRule(Object.keys(fields).every(k=>allowed.includes(k)),'Unknown front matter field.',400);
 if(hasFrontmatter)for(const key of ['id','title','sourceType','policyStatus','collection'])requireRule(Object.hasOwn(fields,key),`Front matter requires ${key}.`,400);
 const metadata={id:relative,title:content.match(/^#\s+(.+)$/m)?.[1]?.trim()??relative,sourceType:'reference',policyStatus:'proposed',collection:'company',category:'',tags:[],index:true,...defaults,...fields} as DocumentMetadata;
 requireRule(typeof metadata.id==='string'&&metadata.id.length<=200&&(hasFrontmatter?/^[a-z0-9][a-z0-9._/-]*$/.test(metadata.id):!!metadata.id),'Invalid stable document id.',400);
 requireRule(typeof metadata.title==='string'&&metadata.title.trim().length>0&&metadata.title.length<=300,'Invalid document title.',400);
 requireRule(['reference','handbook'].includes(metadata.sourceType),'Invalid sourceType.',400);
 requireRule(['approved','observed','proposed','historical'].includes(metadata.policyStatus),'Invalid policyStatus.',400);
 requireRule(typeof metadata.collection==='string'&&/^[a-z][a-z0-9_-]{0,79}$/.test(metadata.collection),'Invalid collection key.',400);
 requireRule(typeof metadata.category==='string'&&metadata.category.length<=120,'Invalid category.',400);
 requireRule(Array.isArray(metadata.tags)&&metadata.tags.length<=30&&metadata.tags.every(t=>typeof t==='string'&&t.length>0&&t.length<=80),'Invalid tags.',400);
 requireRule(typeof metadata.index==='boolean','index must be boolean.',400);
 requireRule(content.trim()&&!content.includes('\0'),'Document body is empty or binary.',400);
 return {relative,metadata,content,hasFrontmatter};
}
export async function readKnowledgeDirectory(directory:string,options:{strict?:boolean;defaults?:(relative:string)=>Partial<DocumentMetadata>}={}){
 const root=await realpath(directory);requireRule((await stat(root)).isDirectory(),'Expected a documentation directory.',400);const files:KnowledgeFile[]=[],ids=new Set<string>();
 async function walk(folder:string){for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.name.startsWith('.')||entry.isSymbolicLink()||['node_modules','vendor','dist','build'].includes(entry.name))continue;
  const absolute=path.join(folder,entry.name),relative=path.relative(root,absolute).split(path.sep).join('/');
  if(entry.isDirectory()){await walk(absolute);continue;}
  if(!entry.isFile()||!['.md','.txt'].includes(path.extname(entry.name).toLowerCase()))continue;
  try{requireRule((await stat(absolute)).size<=500000,'Document exceeds 500 KB.',400);const file=parseKnowledgeFile(await readFile(absolute,'utf8'),relative,options.defaults?.(relative),options.strict);requireRule(!ids.has(file.metadata.id),'Duplicate stable document id.',400);ids.add(file.metadata.id);files.push(file);}catch(error){throw new Error(`${relative}: ${error instanceof Error?error.message:'Invalid document'}`);}
 }}
 await walk(root);return files;
}
