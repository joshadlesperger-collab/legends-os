import { NextRequest, NextResponse } from "next/server";
import { createOperatorSession, OPERATOR_SESSION_COOKIE, OPERATOR_SESSION_SECONDS, operatorAuthConfigured, verifyOperatorPassword } from "@/lib/operator-auth";

function safeNext(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/today";
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNext(form.get("next"));
  if (!operatorAuthConfigured()) return NextResponse.redirect(new URL(`/login?configuration=missing`, request.url), 303);
  if (!await verifyOperatorPassword(String(form.get("password") || ""))) return NextResponse.redirect(new URL(`/login?error=invalid&next=${encodeURIComponent(next)}`, request.url), 303);
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(OPERATOR_SESSION_COOKIE, await createOperatorSession(), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: OPERATOR_SESSION_SECONDS });
  return response;
}
