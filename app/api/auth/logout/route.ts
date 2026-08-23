import { NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE } from "@/lib/operator-auth";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(OPERATOR_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
