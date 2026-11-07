import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { localEvidence } from "@/lib/card-backlog-service";
import { defaultCardInbox } from "@/lib/card-backlog-store";
import { readCardPhoto } from "@/lib/card-backlog-photo";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return new NextResponse(null,{status:401});
  const id=request.nextUrl.searchParams.get("card"),side=request.nextUrl.searchParams.get("side");
  if (!id || !["front","back"].includes(side || "")) return new NextResponse(null,{status:400});
  try {
    const snapshot=await localEvidence(),card=snapshot.cards.find(c=>c.id===id);
    let photo=null;
    const roots=[defaultCardInbox(),process.env.CARD_SCANNER_PATH||(process.platform==="win32"?"C:\\CardScans":"")].filter(Boolean);
    if(card)for(const root of roots){try{photo=await readCardPhoto(card,side as "front"|"back",root);}catch{/* Missing configured roots do not hide another retained original. */}if(photo)break;}
    if (!photo) return new NextResponse(null,{status:404});
    return new NextResponse(new Uint8Array(photo.bytes),{headers:{"Content-Type":photo.mime,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  } catch { return new NextResponse(null,{status:503}); }
}
