import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth";
import { redirectLocation } from "../../../lib/http";
import { forgetVisitor } from "../../../lib/services";
import {
  SESSION_COOKIE,
  createAnonymousSession,
  safeNextPath,
  sessionTtlSeconds,
  signSession,
} from "../../../lib/session";

export const dynamic = "force-dynamic";

function secureCookie(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  if (proto === "http") return false;
  return new URL(request.url).protocol === "https:";
}

function redirectTo(request: Request, path: string): NextResponse {
  const location = redirectLocation(request, path);
  const response = location.startsWith("/")
    ? new NextResponse(null, { status: 303, headers: { location } })
    : NextResponse.redirect(location, 303);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  const response = redirectTo(request, next);
  const existing = await getSession();
  if (existing) return response;
  const session = createAnonymousSession();
  response.cookies.set({
    name: SESSION_COOKIE,
    value: signSession(session),
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(request),
    path: "/",
    maxAge: sessionTtlSeconds(),
  });
  return response;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const session = await getSession();
  if (form.get("intent") !== "logout" || !session || form.get("csrf") !== session.csrf) {
    return redirectTo(request, session ? "/demo?error=csrf" : "/");
  }
  await forgetVisitor({ tenantId: session.tenantId, userId: session.userId });
  const response = redirectTo(request, "/");
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(request),
    path: "/",
    maxAge: 0,
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
