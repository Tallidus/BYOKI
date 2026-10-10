import { describe, expect, it } from "vitest";
import {
  AIConnectionsError,
  UPSTREAM_ERROR_MESSAGES,
  defineAIConnections,
  type ProviderAdapter,
  type ProviderId,
} from "@byoki/core";
import { createHandlers, type AuthContext } from "../src/handlers.js";
import { createMemoryCredentialStore, createMemoryLedger, createMemorySelectionStore } from "../src/memory.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { createRedactingLogger } from "../src/redact.js";

const KEY = "sk-test-invalid-000";
const RAW = `Incorrect API key provided: sk-test-*******-000. Full key ${KEY} (invalid-000). x-request-id: req_test_leak_000`;

const links = {
  openai: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  anthropic: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  gemini: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
} as const;

function auth(): AuthContext {
  return {
    scope: { tenantId: "local", userId: "visitor" },
    csrfHeader: "token",
    expectedCsrf: "token",
    origin: "http://localhost:3000",
    host: "localhost:3000",
  };
}

function handlers(adapter: ProviderAdapter, logs: string[]) {
  return createHandlers({
    config: defineAIConnections({
      appName: "Cadence",
      capabilities: { chat: { description: "Chat", providers: ["openai"], required: true } },
    }),
    credentials: createMemoryCredentialStore(),
    selections: createMemorySelectionStore(),
    ledger: createMemoryLedger(),
    adapters: { openai: adapter },
    catalog: [],
    links: { ...links },
    rateLimit: createRateLimiter(20, 60_000),
    logger: createRedactingLogger((line) => logs.push(line)),
  });
}

function adapter(overrides: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    id: "openai" satisfies ProviderId,
    supportedCapabilities: ["chat"],
    testMaySpendQuota: false,
    async testConnection() {
      return { ok: true };
    },
    async listModels() {
      return [];
    },
    async invoke() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function assertNoLeak(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("invalid-000");
  expect(text).not.toContain("sk-test");
  expect(text).not.toContain("Incorrect API key");
  expect(text).not.toContain("req_test_leak_000");
  expect(text).not.toContain("x-request-id");
}

describe("connection test responses", () => {
  it("replaces each failure category and a raw adapter reason", async () => {
    const categories = ["invalid_key", "rate_limited", "quota", "unavailable", "unknown"] as const;
    for (const category of categories) {
      const logs: string[] = [];
      const response = await handlers(
        adapter({
          async testConnection() {
            return { ok: false, category, reason: RAW };
          },
        }),
        logs,
      ).testConnection(auth(), "openai", jsonRequest());
      const body = await response.json();
      expect(body.data.category).toBe(category);
      expect(body.data.reason).toBe(UPSTREAM_ERROR_MESSAGES[category]);
      assertNoLeak(JSON.stringify(body));
      assertNoLeak(logs.join("\n"));
      expect(logs.join("\n")).toContain(category);
    }
  });

  it("does not echo a raw reason or a forged category", async () => {
    const logs: string[] = [];
    const response = await handlers(
      adapter({
        async testConnection() {
          return { ok: false, reason: RAW, category: KEY as "invalid_key" };
        },
      }),
      logs,
    ).testConnection(auth(), "openai", jsonRequest());
    const body = await response.json();
    expect(body.data.reason).toBe(UPSTREAM_ERROR_MESSAGES.unknown);
    expect(body.data.category).toBe("unknown");
    assertNoLeak(JSON.stringify(body));
    assertNoLeak(logs.join("\n"));
  });

  it("returns a fixed message when the test throws", async () => {
    const logs: string[] = [];
    const response = await handlers(
      adapter({
        async testConnection() {
          throw new AIConnectionsError("INVALID_KEY", RAW, "req_test_leak_000");
        },
      }),
      logs,
    ).dispatch(jsonRequest("POST", "/api/ai/connections/openai/test"), auth());
    const body = await response.json();
    expect(body.error.message).toBe(UPSTREAM_ERROR_MESSAGES.invalid_key);
    assertNoLeak(JSON.stringify(body));
    assertNoLeak(logs.join("\n"));
  });

  it("does not put upstream text in model refresh warnings", async () => {
    const logs: string[] = [];
    const api = handlers(
      adapter({
        async listModels() {
          throw new AIConnectionsError("RATE_LIMITED", RAW);
        },
      }),
      logs,
    );
    await api.putConnection(auth(), "openai", jsonRequest("PUT", "/api/ai/connections/openai", { apiKey: KEY }));
    const response = await api.dispatch(
      new Request("http://localhost:3000/api/ai/models?capability=chat&discover=1"),
      auth(),
    );
    const body = await response.json();
    expect(body.data.warnings).toEqual([UPSTREAM_ERROR_MESSAGES.rate_limited]);
    assertNoLeak(JSON.stringify(body));
    assertNoLeak(logs.join("\n"));
  });

  it("drops a logged upstream error that contains a masked key", () => {
    const logs: string[] = [];
    const logger = createRedactingLogger((line) => logs.push(line));
    logger.error("credential.test", { detail: RAW, apiKey: KEY });
    const line = logs.join("\n");
    expect(line).toContain("[redacted]");
    assertNoLeak(line);
  });
});

function jsonRequest(method = "POST", path = "/api/ai/connections/openai/test", body: unknown = { apiKey: KEY }): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
