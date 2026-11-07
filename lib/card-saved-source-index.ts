import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint,type Identity} from './card-orchestrator.ts';

/** Candidate lookup only. A cached asking price is never validated pricing or inventory clearance. */
export function savedSourceCandidates(cardId:string,identity:Identity|undefined,root=process.cwd()) {
  const instruction='Unverified candidates only. Check exact variant, condition, shipping and original sale dates; refresh active listings before reliance. No price approval or inventory clearance.';
  try {
    const index=JSON.parse(readFileSync(path.join(root,'artifacts/card-orchestrator/saved-source-index.json'),'utf8'));
    if(!Array.isArray(index.cards)||!Array.isArray(index.sourceEvidence)||!index.sourceEvidence.length)throw Error('Invalid index');
    const card=index.cards.find((c:{cardId:string})=>c.cardId===cardId);
    if(!card||!identity||fingerprint(card.identity)!==fingerprint(identity))return {status:'unavailable',reason:'No index entry for the current reviewed identity',instruction};
    const reportRoot=path.resolve(root,'reports/inventory-snapshots')+path.sep;
    for(const source of index.sourceEvidence) {
      if(typeof source.path!=='string'||typeof source.sha256!=='string')throw Error('Invalid source provenance');
      const file=path.resolve(root,source.path);
      if(!file.startsWith(reportRoot))throw Error('Source outside inventory report directory');
      if(createHash('sha256').update(readFileSync(file)).digest('hex')!==source.sha256)return {status:'stale',reason:'Saved report content changed; rebuild index',instruction};
    }
    if(!Array.isArray(card.candidates))throw Error('Invalid candidates');
    // Explicit projection prevents buyer details or other unrelated report columns leaking into handoffs.
    const candidates=card.candidates.map((r:Record<string,unknown>)=>({source:r.source,itemId:r.itemId,title:r.title,itemPrice:r.itemPrice,shipping:r.shipping,saleDate:r.saleDate,sku:r.sku,kind:r.kind}));
    return {status:'available-unverified',indexedAt:index.observedAt,candidates,activeRequiresRefresh:true,instruction};
  } catch {return {status:'unavailable',reason:'Saved source index or its report provenance cannot be verified',instruction};}
}
