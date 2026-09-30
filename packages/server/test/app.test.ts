import { describe, expect, it } from "vitest";
import { createMockAdapter, defineAIConnections, type ModelOption } from "@byoki/core";
import { createAIConnectionsApp } from "../src/app.js";
import { createMemoryCredentialStore, createMemoryLedger, createMemorySelectionStore } from "../src/memory.js";

const model: ModelOption = {
  id: "openai-mock-chat",
  provider: "openai",
  capabilities: ["chat", "vision"],
  displayName: "OpenAI mock",
  catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
  source: "catalog",
  availabilityCaveat: "May be unavailable.",
};

describe("createAIConnectionsApp", () => {
  it("routes through the supplied stores without a master key", async () => {
    const credentials = createMemoryCredentialStore();
    const selections = createMemorySelectionStore();
    const ledger = createMemoryLedger();
    const scope = { tenantId: "local", userId: "user-a" };
    await credentials.put(scope, "openai", "valid-key");
    await selections.put(scope, { capability: "chat", provider: "openai", modelId: model.id });
    const app = createAIConnectionsApp({
      config: defineAIConnections({
        appName: "Garage Assistant",
        capabilities: {
          chat: { description: "Chat", providers: ["openai"], required: true },
        },
      }),
      adapters: { openai: createMockAdapter("openai", { models: [model] }) },
      catalog: [model],
      links: {
        openai: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
        anthropic: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
        gemini: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
      },
      estimateCost: () => ({ status: "unknown", currency: "USD" }),
      credentials,
      selections,
      ledger,
    });
    const result = await app.router.forScope(scope).invoke({
      capability: "chat",
      input: [{ role: "user", text: "Hello" }],
    });
    expect(result.outputText).toContain("mock:chat");
    expect(result.estimationStatus).toBe("unknown");
  });

  it("refuses the development store when the master key is missing", () => {
    expect(() =>
      createAIConnectionsApp({
        config: defineAIConnections({
          appName: "Garage Assistant",
          capabilities: { chat: { description: "Chat", providers: ["openai"] } },
        }),
        adapters: {},
        catalog: [],
        links: {
          openai: { keys: "https://example.com", usage: "https://example.com", billing: "https://example.com", reviewedAt: "2026-09-25" },
          anthropic: { keys: "https://example.com", usage: "https://example.com", billing: "https://example.com", reviewedAt: "2026-09-25" },
          gemini: { keys: "https://example.com", usage: "https://example.com", billing: "https://example.com", reviewedAt: "2026-09-25" },
        },
        estimateCost: () => ({ status: "unknown", currency: "USD" }),
        masterKey: "",
      }),
    ).toThrow(/BYOKI_MASTER_KEY/);
  });
});
