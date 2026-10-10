import { describe, expect, it } from "vitest";
import { AIConnectionsError, type ProviderRequest, type ProviderStreamEvent } from "@byoki/core";
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
    await expect(denied.invoke(request, "sk-supersecretkeyvalue")).rejects.toMatchObject({
      code: "INVALID_KEY",
      message: expect.not.stringContaining("sk-supersecretkeyvalue"),
    });
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

function streamFetch(status: number, body: string): FetchLike & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  };
  return Object.assign(fn, { calls });
}

async function collect(source: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe("provider streaming", () => {
  it("maps OpenAI SSE deltas and usage without echoing a key", async () => {
    const secret = "sk-supersecretkeyvalue";
    const fetchImpl = streamFetch(
      200,
      [
        `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"A "}}]}`,
        "",
        `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"warning."}}]}`,
        "",
        `data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    const adapter = createOpenAIAdapter(fetchImpl);
    const events = await collect(adapter.invokeStream!({ ...request, modelId: "gpt-5.6-luna" }, secret));
    expect(events.filter((event) => event.type === "delta").map((event) => (event.type === "delta" ? event.text : ""))).toEqual([
      "A ",
      "warning.",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.output).toEqual([{ type: "text", text: "A warning." }]);
      expect(done.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, cacheReadTokens: 2 });
      expect(done.providerRequestId).toBe("chatcmpl-1");
    }
    const body = JSON.parse(String(fetchImpl.calls[0]?.init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(fetchImpl.calls[0]?.url).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);

    const leaked = "data: {\"error\":{\"code\":\"invalid_api_key\",\"message\":\"bad key sk-supersecretkeyvalue\"}}\n\n";
    const failing = createOpenAIAdapter(streamFetch(200, `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n${leaked}`));
    const partial: ProviderStreamEvent[] = [];
    await expect(async () => {
      for await (const event of failing.invokeStream!(request, secret)) partial.push(event);
    }).rejects.toMatchObject({
      code: "INVALID_KEY",
      message: expect.not.stringContaining(secret),
    });
    expect(partial).toEqual([{ type: "delta", text: "Hi" }]);
  });

  it("maps Anthropic text deltas and usage", async () => {
    const body = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":11,"cache_read_input_tokens":3}}}`,
      "",
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"It is"}}`,
      "",
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" a gauge."}}`,
      "",
      `event: message_delta`,
      `data: {"type":"message_delta","usage":{"output_tokens":5}}`,
      "",
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      "",
    ].join("\n");
    const fetchImpl = streamFetch(200, body);
    const adapter = createAnthropicAdapter(fetchImpl);
    const events = await collect(adapter.invokeStream!({ ...request, modelId: "claude-sonnet-5" }, "sk-ant-test"));
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.output).toEqual([{ type: "text", text: "It is a gauge." }]);
      expect(done.usage).toMatchObject({ inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 });
      expect(done.providerRequestId).toBe("msg_1");
    }
    const sent = JSON.parse(String(fetchImpl.calls[0]?.init.body));
    expect(sent.stream).toBe(true);
    expect((fetchImpl.calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  });

  it("maps Gemini SSE without putting the key in the URL", async () => {
    const secret = "AIza-test-key";
    const body = [
      `data: {"candidates":[{"content":{"parts":[{"text":"A photo"}]}}]}`,
      "",
      `data: {"responseId":"gem-1","candidates":[{"content":{"parts":[{"text":" of a dashboard."}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":6}}`,
      "",
    ].join("\n");
    const fetchImpl = streamFetch(200, body);
    const adapter = createGeminiAdapter(fetchImpl);
    const events = await collect(adapter.invokeStream!({ ...request, modelId: "gemini-3.5-flash" }, secret));
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.output).toEqual([{ type: "text", text: "A photo of a dashboard." }]);
      expect(done.usage).toMatchObject({ inputTokens: 9, outputTokens: 6 });
    }
    expect(fetchImpl.calls[0]?.url).toContain(":streamGenerateContent?alt=sse");
    expect(fetchImpl.calls[0]?.url).not.toContain(secret);
    expect((fetchImpl.calls[0]?.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(secret);
  });
});
