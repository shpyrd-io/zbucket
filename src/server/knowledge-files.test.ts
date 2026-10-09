import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseKnowledgeFile,readKnowledgeDirectory} from './knowledge-files';
const doc=(extra='')=>`---\nid: warehouse.integrations\ntitle: Integrations\nsourceType: reference\npolicyStatus: observed\ncollection: warehouse\ntags: [api]\n${extra}---\n\n# Integration guide\n\nUse a bearer credential.`;
it('separates metadata from content and rejects invalid or ambiguous YAML',()=>{expect(parseKnowledgeFile(doc(),'a.md',{},true).content).toContain('# Integration guide');for(const s of [doc('index: yes\n'),doc('id: duplicate\n'),doc('unknown: value\n'),doc().replace('observed','invalid'),doc().replace('tags: [api]','tags: &tags [*tags]')])expect(()=>parseKnowledgeFile(s,'a.md',{},true)).toThrow();});
it('validates a directory before writes, rejects duplicate IDs and skips symlinks',async()=>{const root=await mkdtemp(path.join(tmpdir(),'warehouse-docs-'));try{await writeFile(path.join(root,'a.md'),doc());await symlink('/etc',path.join(root,'outside'));expect(await readKnowledgeDirectory(root,{strict:true})).toHaveLength(1);await writeFile(path.join(root,'b.md'),doc());await expect(readKnowledgeDirectory(root,{strict:true})).rejects.toThrow('Duplicate');}finally{await rm(root,{recursive:true,force:true});}});
