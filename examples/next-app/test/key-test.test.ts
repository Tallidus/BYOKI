import { describe, expect, it } from "vitest";
import { UPSTREAM_ERROR_MESSAGES, defineAIConnections } from "@byoki/core";
import { createOpenAIAdapter } from "@byoki/providers";
import {
  createHandlers,
  createMemoryCredentialStore,
  createMemoryLedger,
  createMemorySelectionStore,
  createRateLimiter,
  createRedactingLogger,
  type AuthContext,
} from "@byoki/server";

const KEY = "sk-test-invalid-000";
const REQUEST_ID = "req_test_leak_000";

const links = {
  openai: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  anthropic: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  gemini: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
} as const;

function leak(detail: string): string {
  return `${detail} Incorrect API key provided: sk-test-*******-000. Full key ${KEY} (invalid-000). x-request-id: ${REQUEST_ID}`;
}

function fetchFor(status: number, code: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: { message: leak(code), type: code, code } }), {
      status,
      headers: { "x-request-id": REQUEST_ID, "request-id": REQUEST_ID },
    })) as typeof fetch;
}

function assertNoLeak(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("invalid-000");
  expect(text).not.toContain("sk-test");
  expect(text).not.toContain("Incorrect API key");
  expect(text).not.toContain(REQUEST_ID);
  expect(text).not.toContain("x-request-id");
}

const auth: AuthContext = {
  scope: { tenantId: "local", userId: "visitor" },
  csrfHeader: "token",
  expectedCsrf: "token",
  origin: "http://localhost:3000",
  host: "localhost:3000",
};

describe("key test HTTP response", () => {
  it("returns a fixed category message for each upstream failure", async () => {
    const cases = [
      { status: 401, code: "invalid_api_key", category: "invalid_key" as const },
      { status: 429, code: "insufficient_quota", category: "rate_limited" as const },
      { status: 503, code: "server_error", category: "unavailable" as const },
      { status: 400, code: "something_else", category: "unknown" as const },
    ];
    for (const item of cases) {
      const logs: string[] = [];
      const handlers = createHandlers({
        config: defineAIConnections({
          appName: "Cadence",
          capabilities: { chat: { description: "Chat", providers: ["openai"] } },
        }),
        credentials: createMemoryCredentialStore(),
        selections: createMemorySelectionStore(),
        ledger: createMemoryLedger(),
        adapters: { openai: createOpenAIAdapter(fetchFor(item.status, item.code)) },
        catalog: [],
        links: { ...links },
        rateLimit: createRateLimiter(10, 60_000),
        logger: createRedactingLogger((line) => logs.push(line)),
      });
      const response = await handlers.dispatch(
        new Request("http://localhost:3000/api/ai/connections/openai/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: KEY }),
        }),
        auth,
      );
      const body = await response.json();
      expect(body.data.ok).toBe(false);
      expect(body.data.category).toBe(item.category);
      expect(body.data.reason).toBe(UPSTREAM_ERROR_MESSAGES[item.category]);
      assertNoLeak(JSON.stringify(body));
      assertNoLeak(logs.join("\n"));
    }
  });
});
