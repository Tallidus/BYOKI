import { describe, expect, it } from "vitest";
import { readSessionToken, signSession } from "../lib/session";

process.env.SESSION_SECRET = "test-secret";

describe("session cookie", () => {
  it("round-trips a signed session and rejects tampering", () => {
    const token = signSession({
      userId: "user-a",
      tenantId: "local",
      csrf: "csrf-1",
      exp: Date.now() + 60_000,
    });
    expect(readSessionToken(token)?.userId).toBe("user-a");
    const [payload, sig] = token.split(".");
    expect(readSessionToken(`${payload}.${sig}x`)).toBeNull();
  });
});
