import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const TENANT_ID = "demo";
export const SESSION_COOKIE = "byoki_session";

export type Session = {
  userId: string;
  tenantId: string;
  csrf: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export function sessionTtlSeconds(): number {
  const raw = process.env.BYOKI_SESSION_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(parsed)));
}

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
  if (!token || token.length > 4_000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = parts[0];
  const sig = parts[1];
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let session: Session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
  } catch {
    return null;
  }
  if (!session || typeof session !== "object") return null;
  if (session.tenantId !== TENANT_ID) return null;
  if (typeof session.userId !== "string" || !session.userId.startsWith("v_")) return null;
  if (typeof session.csrf !== "string" || session.csrf.length < 8) return null;
  if (typeof session.exp !== "number" || session.exp <= Date.now()) return null;
  return session;
}

export function createAnonymousSession(now = Date.now()): Session {
  return {
    userId: `v_${randomUUID()}`,
    tenantId: TENANT_ID,
    csrf: randomBytes(16).toString("base64url"),
    exp: now + sessionTtlSeconds() * 1000,
  };
}

/** Relative paths only, so a session redirect cannot leave this host. */
export function safeNextPath(value: string | null | undefined, fallback = "/demo"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.includes("://") || value.includes("\\") || value.includes("\0")) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  if (value.startsWith("/api/session")) return fallback;
  return value;
}
