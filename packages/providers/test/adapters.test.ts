import { describe, expect, it } from "vitest";
import { AIConnectionsError, type ProviderRequest } from "@byoki/core";
import { createAnthropicAdapter } from "../src/anthropic.js";
import { createGeminiAdapter } from "../src/gemini.js";
import { createOpenAIAdapter } from "../src/openai.js";
import type { FetchLike } from "../src/http.js";

const request: ProviderRequest = {
  capability: "vision",
  modelId: "model-under-test",
  timeoutMs: 1000,
  maxOutputTokens: 32,
  input: [
    {
      role: "user",
      parts: [
        { type: "text", text: "What is this?" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
  ],
};

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): FetchLike & {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  return Object.assign(fn, { calls });
}

describe("provider adapters", () => {
  it("maps an OpenAI chat and vision request, usage, and errors", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-5.6-luna" }] } };
      return {
        status: 200,
        body: {
          id: "chatcmpl-1",
          choices: [{ message: { content: "A warning light." } }],
          usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
        },
      };
    });
    const adapter = createOpenAIAdapter(fetchImpl);
    expect(adapter.supportedCapabilities).toEqual(["chat", "vision"]);
    const ok = await adapter.testConnection("sk-test-key");
    expect(ok.ok).toBe(true);
    const result = await adapter.invoke({ ...request, modelId: "gpt-5.6-luna" }, "sk-test-key");
    expect(result.output[0]).toEqual({ type: "text", text: "A warning light." });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, cacheReadTokens: 2 });
    const body = JSON.parse(String(fetchImpl.calls[1]?.init.body));
    expect(body.messages[0].content[1].type).toBe("image_url");
    expect(String(fetchImpl.calls[1]?.init.headers && (fetchImpl.calls[1]?.init.headers as Record<string, string>).authorization)).toContain("Bearer");
    expect(body.model).toBe("gpt-5.6-luna");

    const denied = createOpenAIAdapter(
      mockFetch(() => ({ status: 401, body: { error: { message: "bad key sk-supersecretkeyvalue" } } })),
    );
    await expect(denied.invoke(request, "sk-supersecretkeyvalue")).rejects.toMatchObject({ code: "INVALID_KEY" });
    const limited = createOpenAIAdapter(mockFetch(() => ({ status: 429, body: { error: { message: "slow down" } } })));
    await expect(limited.invoke(request, "sk-test")).rejects.toBeInstanceOf(AIConnectionsError);
    await expect(limited.invoke(request, "sk-test")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps Anthropic messages, image blocks, and model vision flags", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.includes("/models")) {
        return {
          status: 200,
          body: {
            data: [
              { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", capabilities: { image_input: { supported: true } } },
              { id: "claude-text-only", display_name: "Text", capabilities: { image_input: { supported: false } } },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          id: "msg_1",
          content: [{ type: "text", text: "It is a gauge." }],
          usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 3 },
        },
      };
    });
    const adapter = createAnthropicAdapter(fetchImpl);
    const models = await adapter.listModels("sk-ant-test");
    expect(models.find((model) => model.id === "claude-sonnet-5")?.capabilities).toContain("vision");
    expect(models.find((model) => model.id === "claude-text-only")?.capabilities).not.toContain("vision");
    const result = await adapter.invoke({ ...request, modelId: "claude-sonnet-5" }, "sk-ant-test");
    expect(result.usage?.inputTokens).toBe(11);
    const invokeCall = fetchImpl.calls.find((call) => call.url.endsWith("/messages"));
    const body = JSON.parse(String(invokeCall?.init.body));
    expect(body.messages[0].content[1].type).toBe("image");
    expect((invokeCall?.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    const down = createAnthropicAdapter(mockFetch(() => ({ status: 503, body: { error: { message: "unavailable" } } })));
    await expect(down.testConnection("sk-ant-test")).resolves.toMatchObject({ ok: false });
  });

  it("maps Gemini generateContent without putting the key in the URL", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith("/models")) {
        return {
          status: 200,
          body: {
            models: [
              { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-3.1-flash-image", displayName: "Image", supportedGenerationMethods: ["generateContent"] },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          responseId: "gem-1",
          candidates: [{ content: { parts: [{ text: "A photo of a dashboard." }] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 },
        },
      };
    });
    const adapter = createGeminiAdapter(fetchImpl);
    const models = await adapter.listModels("AIza-test-key");
    expect(models.map((model) => model.id)).toEqual(["gemini-3.5-flash"]);
    const result = await adapter.invoke({ ...request, modelId: "gemini-3.5-flash" }, "AIza-test-key");
    expect(result.output[0]).toMatchObject({ text: "A photo of a dashboard." });
    expect(result.usageGaps).not.toContain("inputTokens");
    const invokeCall = fetchImpl.calls.find((call) => call.url.includes(":generateContent"));
    expect(invokeCall?.url).not.toContain("AIza");
    expect((invokeCall?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test-key");
    const body = JSON.parse(String(invokeCall?.init.body));
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe("image/png");
    const missing = createGeminiAdapter(mockFetch(() => ({ status: 404, body: { error: { message: "model gone" } } })));
    await expect(missing.invoke(request, "AIza-test-key")).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });
});
