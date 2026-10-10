import { describe, expect, it } from "vitest";
import { AIConnectionsError, UPSTREAM_ERROR_MESSAGES, createMockAdapter } from "../src/index.js";
import { createDirectClient, detectProvider, type DirectStreamEvent } from "../src/direct.js";
import type { ProviderAdapter, ProviderStreamEvent } from "../src/types.js";

const KEY = "sk-test-invalid-000";

function client() {
  return createDirectClient({
    adapters: {
      openai: createMockAdapter("openai"),
      anthropic: createMockAdapter("anthropic"),
      gemini: createMockAdapter("gemini"),
    },
    catalog: [
      {
        id: "openai-mock-chat",
        provider: "openai",
        capabilities: ["chat", "vision"],
        displayName: "OpenAI mock",
        catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
        source: "catalog",
        availabilityCaveat: "listed",
      },
    ],
  });
}

describe("detectProvider", () => {
  it("checks sk-ant- before sk- and leaves unknown prefixes alone", () => {
    expect(detectProvider("  sk-ant-api03-example  ")).toBe("anthropic");
    expect(detectProvider("sk-proj-example")).toBe("openai");
    expect(detectProvider("sk-example")).toBe("openai");
    expect(detectProvider("AIzaSyExample")).toBe("gemini");
    expect(detectProvider("not-a-key")).toBeNull();
    expect(detectProvider("   ")).toBeNull();
  });
});

describe("createDirectClient", () => {
  it("does not call a provider for an unrecognized key", async () => {
    let calls = 0;
    const adapter = createMockAdapter("openai");
    const wrapped: ProviderAdapter = {
      ...adapter,
      testConnection: async (key) => {
        calls += 1;
        return adapter.testConnection(key);
      },
    };
    const api = createDirectClient({ adapters: { openai: wrapped }, catalog: [] });
    const result = await api.testKey("not-a-provider-key");
    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      provider: null,
      category: "invalid_key",
      message: UPSTREAM_ERROR_MESSAGES.invalid_key,
    });
    expect(result.ok === false && result.message).not.toContain("not-a-provider-key");
  });

  it("tests the detected provider and returns text without provider metadata", async () => {
    const api = client();
    await expect(api.testKey(`  ${KEY}  `)).resolves.toEqual({ ok: true, provider: "openai" });
    const result = await api.invoke({
      apiKey: KEY,
      modelId: "openai-mock-chat",
      input: [{ role: "user", text: "hello" }],
    });
    expect(result.outputText).toBe("mock:chat:hello");
    expect(result.provider).toBe("openai");
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(result)).not.toContain("mock-req");
    expect(api.models({ provider: "openai" }).map((model) => model.id)).toEqual(["openai-mock-chat"]);
  });

  it("streams deltas and then done", async () => {
    const api = client();
    const events: DirectStreamEvent[] = [];
    for await (const event of api.invokeStream({
      apiKey: "sk-ant-example-key",
      modelId: "anthropic-mock-chat",
      input: [{ role: "user", text: "hello" }],
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { outputText: "mock:chat:hello", provider: "anthropic" } });
  });

  it("throws after a delta when the provider fails mid-stream", async () => {
    const leaking = new AIConnectionsError("UPSTREAM_UNAVAILABLE", `down ${KEY} sk-test`, undefined, "unavailable");
    const adapter: ProviderAdapter = {
      ...createMockAdapter("openai"),
      async *invokeStream(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "delta", text: "partial" };
        throw leaking;
      },
    };
    const api = createDirectClient({ adapters: { openai: adapter }, catalog: [] });
    const events: DirectStreamEvent[] = [];
    await expect(async () => {
      for await (const event of api.invokeStream({
        apiKey: KEY,
        modelId: "openai-mock-chat",
        input: [{ role: "user", text: "hello" }],
      })) {
        events.push(event);
      }
    }).rejects.toMatchObject({ message: UPSTREAM_ERROR_MESSAGES.unavailable });
    expect(events).toEqual([{ type: "delta", text: "partial" }]);
  });

  it("rejects a data URL, a bad image type, and too many messages before any call", async () => {
    let calls = 0;
    const adapter = createMockAdapter("openai");
    const wrapped: ProviderAdapter = {
      ...adapter,
      invoke: async (request, key) => {
        calls += 1;
        return adapter.invoke(request, key);
      },
    };
    const api = createDirectClient({ adapters: { openai: wrapped }, catalog: [] });
    await expect(
      api.invoke({
        apiKey: KEY,
        modelId: "openai-mock-chat",
        input: [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: "data:image/png;base64,aaaa" }] }],
      }),
    ).rejects.toMatchObject({ message: "Image data must be raw base64, not a data URL." });
    await expect(
      api.invoke({
        apiKey: KEY,
        provider: "gemini",
        modelId: "openai-mock-chat",
        input: [{ role: "user", text: "hello" }],
      }),
    ).rejects.toMatchObject({ message: UPSTREAM_ERROR_MESSAGES.invalid_key });
    expect(calls).toBe(0);
  });
});
