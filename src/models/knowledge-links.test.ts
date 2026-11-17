import {expect,it} from 'vitest';
import {knowledgeDocumentPath,knowledgeDocumentEndpoint} from './knowledge-links';

it('uses collection-scoped stable identity rather than a title or UUID',()=>{
 expect(knowledgeDocumentPath({collection:'general',key:'zbucket-guide'})).toBe('/knowledge/general/zbucket-guide');
 expect(knowledgeDocumentPath({collection:'other',key:'zbucket-guide'})).not.toBe(knowledgeDocumentPath({collection:'general',key:'zbucket-guide'}));
});
it.each(['bank/cash','a//b','/leading/trailing/','bank/../cash','two words','saldo?bank=1#total','literal%2Fvalue','ação','//example.com'])('preserves the exact key through a browser URL: %s',key=>{
 const url=new URL(knowledgeDocumentPath({collection:'finance',key}),'https://zbucket.example');
 expect(url.origin).toBe('https://zbucket.example');
 expect(url.search).toBe('');expect(url.hash).toBe('');
 expect(decodeURIComponent(url.pathname.slice('/knowledge/finance/'.length))).toBe(key);
});
it.each(['.','..'])('preserves dot-only keys instead of letting the browser traverse paths: %s',key=>{
 const url=new URL(knowledgeDocumentPath({collection:'general',key}),'https://zbucket.example');
 expect(url.pathname).toBe('/knowledge');expect(url.searchParams.get('key')).toBe(key);expect(url.searchParams.get('collection')).toBe('general');
});
it('keeps API history separate from key content and preserves legacy UUID reads',()=>{
 const url=new URL(knowledgeDocumentEndpoint({collection:'finance',key:'a/history?x#y'},true),'https://zbucket.example/');
 expect(url.pathname).toBe('/knowledge/documents/by-key/history');expect(url.searchParams.get('key')).toBe('a/history?x#y');
 expect(knowledgeDocumentEndpoint('01a12791-7888-735b-ad94-bbfce7b58933')).toBe('knowledge/documents/01a12791-7888-735b-ad94-bbfce7b58933');
});
