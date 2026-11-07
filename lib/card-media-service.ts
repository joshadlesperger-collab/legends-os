import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localEvidence } from "./card-backlog-service.ts";
import { defaultCardInbox } from "./card-backlog-store.ts";
import { readCardPhoto } from "./card-backlog-photo.ts";
import { uploadCardImage } from "./ebay-card-media.ts";
import { readHostedCardPhotos } from "./card-bulk-draft-service.ts";
import type { DraftPacket, HostedCardPhoto } from "./card-bulk-draft.ts";

/** Eight images per request, four workers; commit each successful result.
 * The seller is fixed by the authenticated route. Cached uploads never count
 * as saved drafts or authorize moving originals.
 */
export async function hostCardPhotoChunk(packet:DraftPacket,token:string,root=process.cwd()){
  const dir=path.join(root,"artifacts/card-batches");await fs.mkdir(dir,{recursive:true});
  const lock=await fs.open(path.join(dir,"media.lock"),"wx");
  try{
    const photos=await readHostedCardPhotos(root),snapshot=await localEvidence();
    const requested=packet.listings.filter(c=>!c.receipts.length&&c.quantityPlan.route!=="review-existing-quantity").flatMap(c=>[{id:c.id,side:"front" as const,hash:c.originals.frontHash},{id:c.id,side:"back" as const,hash:c.originals.backHashes[0]}]);
    const unique=Array.from(new Map(requested.map(p=>[p.hash,p])).values());
    const pending=unique.filter(p=>!photos.some(h=>h.originalHash===p.hash&&h.uprightReviewed&&Date.parse(h.expiresAt)>Date.now()+86400000));
    const chunk=pending.slice(0,8),errors:string[]=[];let index=0,uploaded=0;
    let writes=Promise.resolve();
    const persist=(photo:HostedCardPhoto)=>{writes=writes.then(async()=>{
      const old=photos.findIndex(p=>p.originalHash===photo.originalHash);if(old>=0)photos.splice(old,1);photos.push(photo);
      const temp=path.join(dir,`${randomUUID()}.tmp`);await fs.writeFile(temp,JSON.stringify(photos,null,2));await fs.rename(temp,path.join(dir,"hosted-photos.json"));
    });return writes;};
    await Promise.all(Array.from({length:Math.min(4,chunk.length)},async()=>{
      while(index<chunk.length){const p=chunk[index++];try{
        const card=snapshot.cards.find(c=>c.id===p.id);if(!card)throw Error("Capture missing");
        let image:Awaited<ReturnType<typeof readCardPhoto>>=null;
        for(const source of [defaultCardInbox(),process.env.CARD_SCANNER_PATH||(process.platform==="win32"?"C:\\CardScans":"")].filter(Boolean)){
          try{image=await readCardPhoto(card,p.side,source);}catch{}if(image)break;
        }
        if(!image)throw Error("Verified original unavailable");
        const result=await uploadCardImage(token,image.bytes,image.mime);
        await persist({originalHash:p.hash,...result,uprightReviewed:true});uploaded++;
      }catch(e){errors.push(`${p.id} ${p.side}: ${e instanceof Error?e.message:"Photo hosting failed"}`);}}
    }));
    return {uploaded,cached:unique.length-pending.length,remaining:pending.length-uploaded,errors,canPublish:false};
  }finally{await lock.close();await fs.unlink(path.join(dir,"media.lock"));}
}
