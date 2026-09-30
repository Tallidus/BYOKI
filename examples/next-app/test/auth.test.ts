import { describe, expect, it } from "vitest";
import { createAnonymousSession, readSessionToken, safeNextPath, sessionTtlSeconds, signSession } from "../lib/session";

process.env.SESSION_SECRET = "test-secret";

describe("session cookie", () => {
  it("round-trips a signed anonymous session and rejects tampering", () => {
    const session = createAnonymousSession();
    const token = signSession(session);
    expect(readSessionToken(token)?.userId).toBe(session.userId);
    expect(session.userId.startsWith("v_")).toBe(true);
    const [payload, sig] = token.split(".");
    expect(readSessionToken(`${payload}.${sig}x`)).toBeNull();
    expect(readSessionToken(`${payload}.${sig}.extra`)).toBeNull();
  });

  it("rejects an expired session", () => {
    const token = signSession({
      userId: "v_user-a",
      tenantId: "demo",
      csrf: "csrf-token",
      exp: Date.now() - 1_000,
    });
    expect(readSessionToken(token)).toBeNull();
  });

  it("clamps the session lifetime", () => {
    process.env.BYOKI_SESSION_TTL_SECONDS = "10";
    expect(sessionTtlSeconds()).toBe(300);
    process.env.BYOKI_SESSION_TTL_SECONDS = "999999";
    expect(sessionTtlSeconds()).toBe(86_400);
    delete process.env.BYOKI_SESSION_TTL_SECONDS;
    expect(sessionTtlSeconds()).toBe(7_200);
  });

  it("only allows same-site paths", () => {
    expect(safeNextPath("/demo")).toBe("/demo");
    expect(safeNextPath("/docs?x=1")).toBe("/docs?x=1");
    expect(safeNextPath("https://evil.example")).toBe("/demo");
    expect(safeNextPath("//evil.example")).toBe("/demo");
    expect(safeNextPath("/\\evil")).toBe("/demo");
    expect(safeNextPath("/api/session?next=/")).toBe("/demo");
  });
});
