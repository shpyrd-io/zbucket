export type KnowledgeIdentity = {collection:string;key:string};

/** Collection + key is immutable; titles and revisions never change the link. */
export function knowledgeDocumentPath(identity:KnowledgeIdentity){
 const {collection,key}=identity;
 // Browsers normalize dot-only path segments, even when percent-encoded.
 if(key==='.'||key==='..')return '/knowledge?'+new URLSearchParams({collection,key});
 return `/knowledge/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`;
}

export function knowledgeDocumentEndpoint(reference:string|KnowledgeIdentity,history=false){
 const suffix=history?'/history':'';
 return typeof reference==='string'
  ? `knowledge/documents/${encodeURIComponent(reference)}${suffix}`
  : `knowledge/documents/by-key${suffix}?`+new URLSearchParams(reference);
}
