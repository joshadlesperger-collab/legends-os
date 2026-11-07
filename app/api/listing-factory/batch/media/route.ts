import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE,readOperatorSession } from "@/lib/operator-auth";
import { prisma } from "@/lib/prisma";
import { getValidAccessToken,setStoredToken } from "@/lib/ebay";
import { measureBatchOperation } from "@/lib/card-batch-metrics";
import { readBatch } from "@/lib/card-batch-store";
import { verifiedBatchPacket } from "@/lib/card-batch-service";
import { hostCardPhotoChunk } from "@/lib/card-media-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const command=z.object({batchId:z.string().uuid(),revision:z.number().int(),originalsUprightReviewed:z.literal(true)}).strict();
export async function POST(req:NextRequest){
  if(!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value))return NextResponse.json({error:"Sign in required"},{status:401});
  if(req.headers.get("origin")!==req.nextUrl.origin)return NextResponse.json({error:"Same-origin request required"},{status:403});
  const raw=await req.text();if(raw.length>1024)return NextResponse.json({error:"Request too large"},{status:413});
  try{
    const input=command.parse(JSON.parse(raw)),batch=await readBatch();
    if(!batch||batch.id!==input.batchId||batch.revision!==input.revision)return NextResponse.json({error:"Batch changed. Refresh before uploading photos."},{status:409});
    const packet=await verifiedBatchPacket(batch,true);
    const stores=await prisma.store.findMany({where:{ebaySellerUsername:"imaydit58",isActive:true,connectionStatus:"connected"},take:2});
    if(stores.length!==1)return NextResponse.json({error:"A single connected imaydit58 eBay account is required. Use the existing store connection flow."},{status:409});
    const store=stores[0],bundle=await getValidAccessToken(store);
    if(bundle.expiresAt.getTime()!==store.tokenExpiresAt?.getTime())await prisma.store.update({where:{id:store.id},data:{oauthAccessToken:setStoredToken(bundle.accessToken),oauthRefreshToken:bundle.refreshToken?setStoredToken(bundle.refreshToken):store.oauthRefreshToken,tokenExpiresAt:bundle.expiresAt}});
    return NextResponse.json(await measureBatchOperation(batch,"photos",()=>hostCardPhotoChunk(packet,bundle.accessToken)),{headers:{"Cache-Control":"private, no-store"}});
  }catch{return NextResponse.json({error:"Photo hosting unavailable. Check batch approvals, original-photo holds, the store connection and any running upload. Successful images are retained; nothing was published."},{status:409});}
}
