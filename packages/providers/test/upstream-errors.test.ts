import { describe, expect, it } from "vitest";
import { AIConnectionsError, UPSTREAM_ERROR_MESSAGES, type ProviderRequest } from "@byoki/core";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createGeminiAdapter } from "../src/gemini.js";
import type { FetchLike } from "../src/http.js";
import { createOpenAIAdapter } from "../src/openai.js";

const KEY = "sk-test-invalid-000";
const REQUEST_ID = "req_test_leak_000";
const HEADER_ID = "req_header_leak_000";

const invokeRequest: ProviderRequest = {
  capability: "chat",
  modelId: "gpt-test",
  timeoutMs: 1000,
  input: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

function leakMessage(detail: string): string {
  return `${detail} Incorrect API key provided: sk-test-*******-000. Full key ${KEY} (invalid-000). x-request-id: ${REQUEST_ID}`;
}

function responseFor(status: number, body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "x-request-id": REQUEST_ID,
        "request-id": HEADER_ID,
        "x-api-key": KEY,
      },
    });
}

function assertNoLeak(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("invalid-000");
  expect(text).not.toContain("sk-test");
  expect(text).not.toContain("Incorrect API key");
  expect(text).not.toContain(REQUEST_ID);
  expect(text).not.toContain(HEADER_ID);
  expect(text).not.toContain("x-request-id");
  expect(text).not.toContain("x-api-key");
}

describe("upstream errors stay off the visitor result", () => {
  it("returns a fixed message for an invalid key, rate limit, outage, and unknown failure", async () => {
    const cases = [
      {
        category: "invalid_key" as const,
        status: 401,
        body: { error: { message: leakMessage("bad"), type: "invalid_request_error", code: "invalid_api_key" } },
      },
      {
        category: "rate_limited" as const,
        status: 429,
        body: { error: { message: leakMessage("quota"), type: "insufficient_quota", code: "insufficient_quota" } },
      },
      {
        category: "unavailable" as const,
        status: 503,
        body: { error: { message: leakMessage("down"), type: "server_error", code: "server_error" } },
      },
      {
        category: "unknown" as const,
        status: 400,
        body: { error: { message: leakMessage("weird"), type: "invalid_request_error", code: "something_else" } },
      },
    ];

    for (const item of cases) {
      const adapter = createOpenAIAdapter(responseFor(item.status, item.body));
      const result = await adapter.testConnection(KEY);
      expect(result.ok).toBe(false);
      expect(result.category).toBe(item.category);
      expect(result.reason).toBe(UPSTREAM_ERROR_MESSAGES[item.category]);
      assertNoLeak(JSON.stringify(result));

      await expect(adapter.invoke(invokeRequest, KEY)).rejects.toBeInstanceOf(AIConnectionsError);
      try {
        await adapter.invoke(invokeRequest, KEY);
      } catch (error) {
        expect(error).toBeInstanceOf(AIConnectionsError);
        const parsed = error as AIConnectionsError;
        expect(parsed.message).toBe(
          item.category === "unknown" ? UPSTREAM_ERROR_MESSAGES.unknown : UPSTREAM_ERROR_MESSAGES[item.category],
        );
        assertNoLeak(parsed.message);
        expect(JSON.stringify({ code: parsed.code, message: parsed.message })).not.toContain(REQUEST_ID);
      }
    }
  });

  it("does not copy a plain-text provider body", async () => {
    const adapter = createOpenAIAdapter(
      async () =>
        new Response(leakMessage("plain"), {
          status: 401,
          headers: { "x-request-id": REQUEST_ID, authorization: `Bearer ${KEY}` },
        }),
    );
    const result = await adapter.testConnection(KEY);
    expect(result).toEqual({
      ok: false,
      reason: UPSTREAM_ERROR_MESSAGES.invalid_key,
      category: "invalid_key",
    });
    assertNoLeak(JSON.stringify(result));
  });

  it("hides timeout and network failures that echo the key", async () => {
    const timeout = createOpenAIAdapter(async () => {
      const error = new Error(`aborted ${KEY} sk-test invalid-000`);
      error.name = "AbortError";
      throw error;
    });
    await expect(timeout.testConnection(KEY)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: UPSTREAM_ERROR_MESSAGES.unavailable,
    });

    const offline = createOpenAIAdapter(async () => {
      throw new Error(`connect ECONNREFUSED ${KEY} invalid-000 sk-test`);
    });
    await expect(offline.testConnection(KEY)).rejects.toMatchObject({
      message: UPSTREAM_ERROR_MESSAGES.unavailable,
    });
    try {
      await offline.testConnection(KEY);
    } catch (error) {
      assertNoLeak(error instanceof Error ? error.message : "");
    }
  });

  it("uses the same fixed invalid-key message for Anthropic and Gemini", async () => {
    const body = { error: { message: leakMessage("nope"), type: "authentication_error", code: "authentication_error" } };
    const anthropic = await createAnthropicAdapter(responseFor(401, body)).testConnection(KEY);
    const gemini = await createGeminiAdapter(responseFor(401, body)).testConnection(KEY);
    expect(anthropic.reason).toBe(UPSTREAM_ERROR_MESSAGES.invalid_key);
    expect(gemini.reason).toBe(UPSTREAM_ERROR_MESSAGES.invalid_key);
    assertNoLeak(JSON.stringify(anthropic));
    assertNoLeak(JSON.stringify(gemini));
  });
});
