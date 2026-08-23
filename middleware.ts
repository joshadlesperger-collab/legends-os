import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";

const publicPaths = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/ebay/account-deletion",
  "/api/stores/callback",
  "/api/internal/jobs/process",
  "/api/reconciliation/run",
]);

export async function middleware(request: NextRequest) {
  if (publicPaths.has(request.nextUrl.pathname)) return NextResponse.next();
  const session = await readOperatorSession(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Operator sign-in required" }, { status: 401 });
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"] };
