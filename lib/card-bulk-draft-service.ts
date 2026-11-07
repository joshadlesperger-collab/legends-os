import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { verifiedBatchPacket } from "./card-batch-service.ts";
import { bulkDraftExport } from "./card-bulk-draft.ts";
import type { TimedBatch } from "./card-batch.ts";
import { measureBatchOperation } from "./card-batch-metrics.ts";
const hosted=z.array(z.object({originalHash:z.string().regex(/^[a-f0-9]{64}$/),url:z.string().url(),expiresAt:z.string(),uprightReviewed:z.boolean(),resourceUri:z.string().optional()}).strict()).max(4000);
export async function readHostedCardPhotos(root=process.cwd()){
  let photos:z.infer<typeof hosted>=[];
  try{photos=hosted.parse(JSON.parse(await fs.readFile(path.join(root,"artifacts/card-batches/hosted-photos.json"),"utf8")));}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("Hosted photo manifest is invalid; revalidate image hosting.");}
  return photos;
}
export async function verifiedBulkDraftExport(batch:TimedBatch,root=process.cwd()){
  return measureBatchOperation(batch,"ebay-entry",async()=>{
    const packet=await verifiedBatchPacket(batch,true);
    return {...bulkDraftExport(packet,await readHostedCardPhotos(root)),plan:packet.plan};
  },root);
}
