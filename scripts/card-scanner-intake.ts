import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {withQueue} from '../lib/card-orchestrator-store.ts';
import {validateCardIntake,upsertCard,fingerprint,type CardInput} from '../lib/card-orchestrator.ts';

// Bounded, additive admission. Identity review and all external-write gates remain separate.
async function main() {
  const file=process.argv[2];
  if(!file)throw Error('Provide an explicit scanner intake packet');
  const packet=JSON.parse(await readFile(file,'utf8'));
  const cards:CardInput[]=packet.cards;
  if(!Array.isArray(cards)||!cards.length||cards.length>20)throw Error('Expected 1–20 explicit cards');
  if(new Set(cards.map(c=>c.id)).size!==cards.length)throw Error('Duplicate card IDs');
  for(const card of cards) {
    validateCardIntake(card);
    if(!card.source.startsWith('scanner-intake:')||card.knownDraft||card.knownLive||card.savedReceipts||card.override||card.candidates.length)throw Error('Intake cannot supply receipts, pricing or approvals');
    for(const photo of card.photos)if(createHash('sha256').update(await readFile(photo.path)).digest('hex')!==photo.sha256.toLowerCase())throw Error(`Original hash mismatch: ${card.id}`);
  }
  const result=await withQueue('artifacts/card-orchestrator',state=>{
    // Prevalidate the whole packet before any in-memory mutation.
    const hashes=new Map<string,string>();
    for(const existing of Object.values(state.cards))for(const p of existing.input.photos)hashes.set(p.sha256.toLowerCase(),existing.input.id);
    for(const card of cards){
      const old=state.cards[card.id];
      if(old&&fingerprint(old.input)!==fingerprint(card))throw Error(`Existing capture must use its normal review flow: ${card.id}`);
      for(const p of card.photos){const owner=hashes.get(p.sha256.toLowerCase());if(owner&&owner!==card.id)throw Error(`Capture already owned by ${owner}`);hashes.set(p.sha256.toLowerCase(),card.id);}
    }
    return cards.map(card=>({id:card.id,added:state.cards[card.id]?false:upsertCard(state,card)}));
  });
  console.log(JSON.stringify({cards:result,externalWrites:0}));
}
main().catch((e:unknown)=>{console.error(e instanceof Error?e.message:'Intake failed');process.exitCode=1;});
