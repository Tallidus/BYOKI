import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { DEMO_USERS, clearCookie, sessionCookie, signSession } from "../../../lib/session";

export async function POST(request: Request) {
  const form = await request.formData();
  if (form.get("intent") === "logout") {
    return NextResponse.redirect(new URL("/", request.url), {
      headers: { "set-cookie": clearCookie() },
    });
  }
  const userId = String(form.get("userId") ?? "");
  const password = String(form.get("password") ?? "");
  const user = DEMO_USERS.find((item) => item.id === userId && item.password === password);
  if (!user) {
    return NextResponse.redirect(new URL("/?error=1", request.url));
  }
  const token = signSession({
    userId: user.id,
    tenantId: "local",
    csrf: randomBytes(16).toString("base64url"),
    exp: Date.now() + 24 * 60 * 60 * 1000,
  });
  return NextResponse.redirect(new URL("/settings", request.url), {
    headers: { "set-cookie": sessionCookie(token) },
  });
}
