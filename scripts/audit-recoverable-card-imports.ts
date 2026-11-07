import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {importLegacyCard} from "../lib/card-orchestrator-import.ts";
import {validateCardIntake} from "../lib/card-orchestrator.ts";
const files=["artifacts/card-orchestrator/state.json","artifacts/identity-queue/cards.json","artifacts/pricing-queue/queue-state.json"];
const texts=files.map(f=>readFileSync(f,"utf8"));
const [state,identities,pricing]=texts.map(t=>JSON.parse(t));
const prices=new Map(pricing.cards.map((c:any)=>[c.card_id,c]));
const rows=identities.cards.filter((i:any)=>state.rejectedImports?.[i.card_id]?.reason==="Identity source is missing required fields; retain in identity inbox").map((i:any)=>{
 let outcome:string,missingOriginals:string[]=[],receipt=false;
 try{
  const input=importLegacyCard(i,prices.get(i.card_id),[]);validateCardIntake(input);
  missingOriginals=input.photos.filter(p=>!existsSync(p.path)).map(p=>p.side);
  outcome=missingOriginals.length?"originals-unavailable":"intake-candidate";
  receipt=!!(input.knownLive||input.knownDraft);
 }catch(error){outcome=error instanceof Error?error.message:String(error);}
 return {id:i.card_id,player:i.player,outcome,missingOriginals,hasSavedReceipt:receipt};
});
files.forEach((f,n)=>{if(readFileSync(f,"utf8")!==texts[n])throw Error("Source changed during import audit");});
const counts=rows.reduce((a:Record<string,number>,r:any)=>(a[r.outcome]=(a[r.outcome]??0)+1,a),{});
const report={at:new Date().toISOString(),revision:state.revision,sources:files.map((file,n)=>({file,sha256:createHash("sha256").update(texts[n]).digest("hex")})),counts,rows,
 limitations:"Candidate means intake schema and original-path existence only. Supported sync must still check manifest receipts; photo jobs must hash originals; identity needs independent visual review. No automatic identity, pricing or listing completion."};
const output=`artifacts/engineering-mission/recoverable-imports-${Date.now()}.json`;
writeFileSync(output,JSON.stringify(report,null,2),{flag:"wx"});console.log(JSON.stringify({output,counts,revision:state.revision},null,2));
