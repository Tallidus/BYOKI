import { describe, expect, it } from "vitest";
import {
  AIConnectionsError,
  UPSTREAM_ERROR_MESSAGES,
  connectionTestCategory,
  connectionTestMessage,
  messageForVisitor,
} from "../src/errors.js";

const KEY = "sk-test-invalid-000";
const RAW = `Incorrect API key provided: sk-test-*******-000. Full key ${KEY} (invalid-000). request-id: req_test_leak_000`;

describe("visitor error text", () => {
  it("replaces a raw test reason with the unknown message", () => {
    const message = connectionTestMessage({ ok: false, reason: RAW });
    expect(message).toBe(UPSTREAM_ERROR_MESSAGES.unknown);
    expect(connectionTestCategory({ ok: false, reason: RAW, category: KEY })).toBe("unknown");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("invalid-000");
    expect(message).not.toContain("sk-test");
    expect(message).not.toContain("Incorrect API key");
    expect(message).not.toContain("req_test_leak_000");
  });

  it("maps the previous mock rejection string onto the invalid-key message", () => {
    expect(connectionTestMessage({ ok: false, reason: "The provider rejected this key." })).toBe(
      UPSTREAM_ERROR_MESSAGES.invalid_key,
    );
    expect(connectionTestCategory({ ok: false, reason: "The provider rejected this key." })).toBe("invalid_key");
  });

  it("uses the category message and drops a raw reason", () => {
    for (const category of ["invalid_key", "rate_limited", "unavailable", "unknown"] as const) {
      const message = connectionTestMessage({ ok: false, category, reason: RAW });
      expect(message).toBe(UPSTREAM_ERROR_MESSAGES[category]);
      expect(message).not.toContain("sk-test");
      expect(message).not.toContain("invalid-000");
    }
  });

  it("maps upstream error codes onto fixed messages", () => {
    const invalid = messageForVisitor(new AIConnectionsError("INVALID_KEY", RAW, "req_test_leak_000"));
    expect(invalid).toBe(UPSTREAM_ERROR_MESSAGES.invalid_key);
    expect(invalid).not.toContain("req_test_leak_000");
    expect(messageForVisitor(new AIConnectionsError("RATE_LIMITED", RAW))).toBe(UPSTREAM_ERROR_MESSAGES.rate_limited);
    expect(messageForVisitor(new AIConnectionsError("UPSTREAM_UNAVAILABLE", RAW))).toBe(
      UPSTREAM_ERROR_MESSAGES.unavailable,
    );
    expect(messageForVisitor(new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown))).toBe(
      UPSTREAM_ERROR_MESSAGES.unknown,
    );
    expect(messageForVisitor(new AIConnectionsError("MODEL_UNAVAILABLE", RAW))).toBe(
      "That model is not available. Choose another model.",
    );
    expect(messageForVisitor(new AIConnectionsError("INVALID_KEY", "Enter a provider API key."))).toBe(
      "Enter a provider API key.",
    );
  });
});
