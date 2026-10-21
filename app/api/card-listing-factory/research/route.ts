import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { researchFactorySoldComps, SOLD_RESEARCH_UNCONFIGURED_MESSAGE } from "@/lib/card-sold-research";

const text = z.string().trim().min(1).max(200);
const identitySchema = z.object({ sport: z.enum(["Baseball","Football","Basketball","Hockey","Soccer","Other"]), player:text, year:z.number().int().min(1880).max(2100), manufacturer:text, set:text, cardNumber:text,
  team:z.string().max(200).optional(), parallel:z.string().max(200).optional(), serialNumber:z.string().max(100).optional(), numberedTo:z.number().int().positive().optional(),
  rookie:z.boolean().optional(), autograph:z.boolean().optional(), graded:z.boolean().optional(), grade:z.string().max(100).optional(), condition:z.string().max(300).optional() });
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error:"Operator sign-in required." },{status:401});
  if (request.headers.get("origin") && request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({error:"Same-origin request required."},{status:403});
  if (!process.env.THE_CARD_API_KEY) return NextResponse.json({status:"not-configured", comps:[], excluded:[], message:SOLD_RESEARCH_UNCONFIGURED_MESSAGE});
  try {
    const body = await request.text(); if(body.length>10_000) return NextResponse.json({error:"Identity request too large."},{status:413});
    const identity = identitySchema.parse(JSON.parse(body).identity);
    return NextResponse.json(await researchFactorySoldComps(identity, AbortSignal.any([request.signal,AbortSignal.timeout(20_000)])),{headers:{"Cache-Control":"no-store"}});
  } catch { return NextResponse.json({error:"Sold-data research could not complete; existing evidence was preserved."},{status:502}); }
}
