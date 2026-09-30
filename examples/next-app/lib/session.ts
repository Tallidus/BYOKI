import { createHmac, timingSafeEqual } from "node:crypto";

export const TENANT_ID = "local";

export const DEMO_USERS = [
  { id: "user-a", name: "Alice", password: "alice" },
  { id: "user-b", name: "Bob", password: "bob" },
] as const;

export type Session = { userId: string; tenantId: string; csrf: string; exp: number };

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required.");
  return value;
}

export function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function readSessionToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
  if (session.exp < Date.now()) return null;
  return session;
}

export function sessionCookie(token: string): string {
  return `byoki_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

export function clearCookie(): string {
  return "byoki_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
