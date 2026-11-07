import test from 'node:test';
import assert from 'node:assert/strict';
import { newQueue,upsertCard,validDraftGroup,type Identity } from '../lib/card-orchestrator.ts';
import { configureDraftWriter,claimDraftWriter,draftBinding } from '../lib/card-draft-lifecycle.ts';
import { beginDraftConsolidation,finishDraftConsolidation } from '../lib/card-draft-consolidation.ts';
const now='2026-10-28T23:00:00.000Z';
function fixture(){const s=newQueue(),i:Identity={player:'Test',season:'2025',set:'Bowman Chrome',manufacturer:'Topps',cardNumber:'BCP-1',sport:'Baseball',team:'Brewers',parallel:'Base',serial:'',printRun:null,condition:'Near mint or better',autograph:false,patch:false,language:'English'};
 for(let n=1;n<=3;n++){const id='card-'+n;upsertCard(s,{id,sku:id,identity:i,photos:[{side:'front',path:id+'f',sha256:String(n).repeat(64)},{side:'back',path:id+'b',sha256:String(n+3).repeat(64)}],source:'test',candidates:[],knownDraft:String(n)},now);const c=s.cards[id];c.jobs.photos.state='done';c.jobs.identity.state='done';c.jobs.identity.result={identity:i};c.draftLifecycle={binding:draftBinding(c),draftId:String(n),state:'saved',observedAt:now,evidence:'saved existing draft'};}
 configureDraftWriter(s,'test',Object.keys(s.cards),'Explicit scoped consolidation approval',now);const lease=claimDraftWriter(s,'test',now);
 const p={id:'consolidate-test',evidence:'Exact approved deletion and quantity correction',groups:[{keepCardId:'card-1',members:[1,2,3].map(n=>({cardId:'card-'+n,draftId:String(n)}))}]};return {s,p,token:lease.lease!.token};}
test('consolidation retains IDs and validates all evidence before atomic adoption',()=>{const {s,p,token}=fixture();beginDraftConsolidation(s,p,'test',token,now);
 const proof={observedAt:now,evidence:'Saved and reopened primary, complete inventory after approved deletion',inventoryAx:'0 AXWebArea Manage drafts '+'.'.repeat(100)+'\n1 heading Results:1-1 of 1\n2 checkbox ID: shui-dt-checkone-1',reopened:[{cardId:'card-1',url:'https://www.ebay.com/lstng?draftId=1',ax:'0 AXWebArea Complete your listing '+'.'.repeat(100)+'\n1 text field (settable) Custom label (SKU), Value: card-1, ID: sku\n2 text field (settable) Quantity, Value: 3, ID: qty'}]};
 for(const bad of [{...proof,inventoryAx:proof.inventoryAx+'\n3 checkbox ID: shui-dt-checkone-2'},{...proof,reopened:proof.reopened.map(r=>({...r,ax:r.ax.replace('Value: 3','Value: 2')}))}]){const before=JSON.stringify(s);assert.throws(()=>finishDraftConsolidation(s,p.id,bad,'test',token,now));assert.equal(JSON.stringify(s),before);}
 assert.equal(finishDraftConsolidation(s,p.id,proof,'test',token,now),true);assert.equal(finishDraftConsolidation(s,p.id,proof,'test',token,now),false);
 assert.ok(Object.values(s.cards).every(c=>c.input.knownDraft==='1'));assert.equal(s.draftConsolidations![p.id].previous['card-3'].knownDraft,'3');assert.equal(validDraftGroup(s,'1',Object.keys(s.cards)),true);
 s.cards['card-3'].input.photos[0].sha256='a'.repeat(64);assert.equal(validDraftGroup(s,'1',Object.keys(s.cards)),false);
});
test('consolidation rejects mixed variants, repeated captures and unknown draft IDs',()=>{for(const mode of ['variant','capture','draft']){const {s,p,token}=fixture();if(mode==='variant')s.cards['card-3'].jobs.identity.result={identity:{...s.cards['card-3'].input.identity,parallel:'Refractor'}};if(mode==='capture')s.cards['card-3'].input.photos[0].sha256=s.cards['card-1'].input.photos[0].sha256;if(mode==='draft')p.groups[0].members[2].draftId='999';assert.throws(()=>beginDraftConsolidation(s,p,'test',token,now));assert.equal(s.draftConsolidations,undefined);}});

