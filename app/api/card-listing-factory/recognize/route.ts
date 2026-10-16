import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { recognizeCard } from "@/lib/card-recognition-provider";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
let active = 0;
export async function GET(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Operator sign-in required." }, { status: 401 });
  return NextResponse.json({ recognitionConfigured: !!process.env.OPENAI_API_KEY, soldCompsConfigured: !!process.env.THE_CARD_API_KEY }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  if (!await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Operator sign-in required." }, { status: 401 });
  if (request.headers.get("origin") && request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error: "Same-origin request required." }, { status: 403 });
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "Photo recognition is not configured on this server." }, { status: 503 });
  if (active >= 2) return NextResponse.json({ error: "Recognition is busy. Try again after the current card finishes." }, { status: 429 });
  active++;
  try {
    // Read a bounded stream before parsing JSON; Content-Length alone is not trustworthy.
    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ error: "Photo previews required." }, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4_100_000) { await reader.cancel(); return NextResponse.json({ error: "Photo previews are too large." }, { status: 413 }); } chunks.push(value); }
    let body: { images?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return NextResponse.json({ error: "Invalid photo request." }, { status: 400 }); }
    const result = await recognizeCard(body.images, AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Never return provider payloads, embedded image bytes or credentials.
    return NextResponse.json({ error: "Photo recognition could not complete. Check provider access, image clarity, and try again; existing fields were preserved." }, { status: 502 });
  } finally { active--; }
}
