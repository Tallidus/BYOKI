import { describe, expect, it } from "vitest";
import { AIConnectionsError, TASK_UNSUPPORTED_MESSAGE, createMockAdapter } from "../src/index.js";
import { defineAIConnections } from "../src/config.js";
import { createDirectClient } from "../src/direct.js";
import { categorizeModel, isTaskMismatchBody, modelAckName, partitionModels } from "../src/models.js";
import type { ModelOption, ProviderAdapter } from "../src/types.js";

describe("categorizeModel", () => {
  it("uses provider metadata and name heuristics", () => {
    expect(categorizeModel("openai", "gpt-5.6-terra")).toEqual(expect.arrayContaining(["chat", "vision"]));
    expect(categorizeModel("openai", "text-embedding-3-small")).toEqual(["embedding"]);
    expect(categorizeModel("openai", "whisper-1")).toEqual(["audio"]);
    expect(categorizeModel("openai", "dall-e-3")).toEqual(["image"]);
    expect(categorizeModel("openai", "gpt-image-1")).toEqual(["image"]);
    expect(
      categorizeModel("anthropic", "claude-sonnet-5", { imageInput: true }),
    ).toEqual(expect.arrayContaining(["chat", "vision"]));
    expect(categorizeModel("anthropic", "claude-text-only", { imageInput: false })).not.toContain("vision");
    expect(categorizeModel("anthropic", "claude-text-only", { imageInput: false })).toContain("chat");
    expect(
      categorizeModel("gemini", "gemini-3.5-flash", { methods: ["generateContent"] }),
    ).toEqual(expect.arrayContaining(["chat", "vision"]));
    expect(
      categorizeModel("gemini", "gemini-3.1-flash-image", { methods: ["generateContent"] }),
    ).toContain("image");
    expect(categorizeModel("gemini", "text-embedding-004", { methods: ["embedContent"] })).toEqual(["embedding"]);
  });

  it("does not treat a parameter rejection as a task mismatch", () => {
    expect(isTaskMismatchBody(JSON.stringify({ error: { code: "unsupported_parameter", message: "temperature is not supported" } }))).toBe(false);
    expect(isTaskMismatchBody(JSON.stringify({ error: { message: "The model does not support image input." } }))).toBe(true);
  });
});

describe("discoverModels", () => {
  const catalog: ModelOption[] = [
    {
      id: "gpt-5.6-terra",
      provider: "openai",
      capabilities: ["chat", "vision"],
      displayName: "GPT-5.6 Terra",
      catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
      source: "catalog",
      availabilityCaveat: "listed",
    },
  ];

  it("caches a provider list for the session and falls back when listing fails", async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      ...createMockAdapter("openai"),
      async listModels() {
        calls += 1;
        if (calls === 1) throw new Error("cors");
        return [
          {
            id: "gpt-5.6-luna",
            provider: "openai",
            capabilities: ["chat"],
            displayName: "gpt-5.6-luna",
            catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
            source: "discovered",
            availabilityCaveat: "listed",
          },
          {
            ...catalog[0]!,
            source: "discovered",
            capabilities: ["chat"],
          },
        ];
      },
    };
    const api = createDirectClient({ adapters: { openai: adapter }, catalog });
    const first = await api.discoverModels("sk-test-key");
    expect(first.fallback).toBe(true);
    expect(first.models.map((model) => model.id)).toEqual(["gpt-5.6-terra"]);
    const cached = await api.discoverModels("sk-test-key");
    expect(cached.fallback).toBe(true);
    expect(calls).toBe(1);
    const refreshed = await api.discoverModels("sk-test-key", { refresh: true, capability: "chat" });
    expect(refreshed.fallback).toBe(false);
    expect(refreshed.models.map((model) => model.displayName)).toContain("GPT-5.6 Terra");
    expect(refreshed.models.find((model) => model.id === "gpt-5.6-terra")?.capabilities).toContain("vision");
    expect(JSON.stringify(refreshed)).not.toContain("sk-test-key");
  });

  it("refuses a known model that cannot do the request", async () => {
    const api = createDirectClient({
      adapters: { openai: createMockAdapter("openai") },
      catalog: [{ ...catalog[0]!, id: "text-embedding-3-small", capabilities: ["embedding"], displayName: "Embed" }],
    });
    await expect(
      api.invoke({ apiKey: "sk-test-key", modelId: "text-embedding-3-small", input: [{ role: "user", text: "hi" }] }),
    ).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE", message: TASK_UNSUPPORTED_MESSAGE });
  });
});

describe("recommended model config", () => {
  it("requires the default to be one of the recommended models", () => {
    const config = defineAIConnections({
      appName: "Dungeon Assistant",
      capabilities: {
        chat: {
          description: "Stat blocks",
          providers: ["openai", "anthropic"],
          recommendedModels: [
            { provider: "openai", modelId: "gpt-5.6-terra" },
            { provider: "anthropic", modelId: "claude-sonnet-5" },
          ],
        },
        image: {
          description: "Artwork",
          providers: ["openai"],
          recommendedModels: [{ provider: "openai", modelId: "gpt-image-1" }],
          defaultModel: { provider: "openai", modelId: "gpt-image-1" },
        },
      },
    });
    expect(config.capabilities.chat?.defaultModel).toEqual({ provider: "openai", modelId: "gpt-5.6-terra" });
    expect(modelAckName("openai", "gpt-image-1")).toBe("byoki.v1.ack.openai.gpt-image-1");
    const parts = partitionModels(
      [
        { provider: "openai" as const, id: "gpt-5.6-terra" },
        { provider: "openai" as const, id: "gpt-4o-mini" },
      ],
      config.capabilities.chat?.recommendedModels,
    );
    expect(parts.recommended.map((model) => model.id)).toEqual(["gpt-5.6-terra"]);
    expect(parts.available.map((model) => model.id)).toEqual(["gpt-4o-mini"]);
    expect(() =>
      defineAIConnections({
        appName: "App",
        capabilities: {
          chat: {
            description: "Chat",
            providers: ["openai"],
            recommendedModels: [{ provider: "openai", modelId: "gpt-5.6-terra" }],
            defaultModel: { provider: "openai", modelId: "other-model" },
          },
        },
      }),
    ).toThrow(AIConnectionsError);
  });
});
