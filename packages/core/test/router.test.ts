import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/mock-adapter.js";
import { createRouter } from "../src/router.js";
import { defineAIConnections } from "../src/config.js";
import { AIConnectionsError } from "../src/errors.js";
import type {
  CredentialStore,
  ModelOption,
  ProviderId,
  Scope,
  Selection,
  SelectionStore,
  UsageLedger,
  UsageRecord,
} from "../src/types.js";

const scope: Scope = { tenantId: "local", userId: "user-a" };

function memory() {
  const keys = new Map<string, string>();
  const selections = new Map<string, Selection>();
  const rows: UsageRecord[] = [];
  const id = (scope: Scope, extra: string) => `${scope.tenantId}:${scope.userId}:${extra}`;
  const credentials: CredentialStore = {
    async put(s, provider, key) {
      keys.set(id(s, provider), key);
    },
    async get(s, provider) {
      return keys.get(id(s, provider)) ?? null;
    },
    async delete(s, provider) {
      keys.delete(id(s, provider));
    },
    async has(s, provider) {
      return keys.has(id(s, provider));
    },
  };
  const selectionStore: SelectionStore = {
    async get(s, capability) {
      return selections.get(id(s, capability)) ?? null;
    },
    async put(s, selection) {
      selections.set(id(s, selection.capability), selection);
    },
    async list(s) {
      return [...selections.entries()]
        .filter(([key]) => key.startsWith(`${s.tenantId}:${s.userId}:`))
        .map(([, value]) => value);
    },
  };
  const ledger: UsageLedger = {
    async append(record) {
      rows.push(record);
    },
    async query(s, range) {
      return rows.filter(
        (row) =>
          row.tenantId === s.tenantId &&
          row.userId === s.userId &&
          row.time >= range.from &&
          row.time < range.to,
      );
    },
  };
  return { credentials, selectionStore, ledger, rows };
}

const catalog: ModelOption[] = [
  {
    id: "openai-mock-chat",
    provider: "openai",
    capabilities: ["chat", "vision"],
    displayName: "OpenAI mock",
    catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
    source: "catalog",
    availabilityCaveat: "May be unavailable on some accounts.",
  },
  {
    id: "anthropic-chat-only",
    provider: "anthropic",
    capabilities: ["chat"],
    displayName: "Anthropic chat",
    catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
    source: "catalog",
    availabilityCaveat: "May be unavailable on some accounts.",
  },
];

function routerFor(stores: ReturnType<typeof memory>, catalogOverride = catalog) {
  const config = defineAIConnections({
    appName: "Garage Assistant",
    capabilities: {
      chat: {
        description: "Answers questions about vehicle repairs.",
        providers: ["openai", "anthropic", "gemini"],
        required: true,
      },
      vision: {
        description: "Analyzes photos you submit.",
        providers: ["openai", "gemini"],
      },
    },
    limits: { budget: { warnAtUsd: 1, blockAtUsd: 5 } },
  });
  return createRouter({
    config,
    adapters: {
      openai: createMockAdapter("openai", { models: catalogOverride.filter((m) => m.provider === "openai") }),
      anthropic: createMockAdapter("anthropic", {
        models: catalogOverride.filter((m) => m.provider === "anthropic"),
      }),
      gemini: createMockAdapter("gemini"),
    },
    credentials: stores.credentials,
    selections: stores.selectionStore,
    ledger: stores.ledger,
    catalog: catalogOverride,
    estimateCost: ({ usage }) =>
      usage?.inputTokens !== undefined && usage.outputTokens !== undefined
        ? { status: "known", currency: "USD", amount: 0.01, catalogVersion: "test" }
        : { status: "unknown", currency: "USD" },
    now: () => new Date("2026-09-25T12:00:00.000Z"),
  });
}

describe("router", () => {
  it("routes a mock chat call and records usage", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "openai", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "openai",
      modelId: "openai-mock-chat",
    });
    const result = await routerFor(stores).forScope(scope).invoke({
      capability: "chat",
      input: [{ role: "user", text: "Explain this dashboard warning." }],
    });
    expect(result.outputText).toContain("mock:chat");
    expect(result.estimationStatus).toBe("known");
    expect(stores.rows).toHaveLength(1);
    expect(stores.rows[0]?.outcome).toBe("success");
    expect(JSON.stringify(stores.rows[0])).not.toContain("dashboard warning");
  });

  it("rejects a provider that is not allowlisted for vision", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "anthropic", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "vision",
      provider: "anthropic" as ProviderId,
      modelId: "anthropic-chat-only",
    });
    await expect(
      routerFor(stores).forScope(scope).invoke({
        capability: "vision",
        input: [{ role: "user", text: "What is in this photo?" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
  });

  it("rejects a model that does not support the capability", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "anthropic", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "anthropic",
      modelId: "anthropic-chat-only",
    });
    const badCatalog: ModelOption[] = [
      { ...catalog[1]!, capabilities: ["vision"] },
    ];
    await expect(
      routerFor(stores, badCatalog).forScope(scope).invoke({
        capability: "chat",
        input: [{ role: "user", text: "Hello" }],
      }),
    ).rejects.toBeInstanceOf(AIConnectionsError);
  });

  it("fails safely after the credential is removed", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "openai", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "openai",
      modelId: "openai-mock-chat",
    });
    await stores.credentials.delete(scope, "openai");
    await expect(
      routerFor(stores).forScope(scope).invoke({
        capability: "chat",
        input: [{ role: "user", text: "Hello" }],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it("records a failed call without storing the prompt", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "openai", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "openai",
      modelId: "missing-model",
    });
    const withMissing = [
      ...catalog,
      {
        ...catalog[0]!,
        id: "missing-model",
      },
    ];
    const configRouter = createRouter({
      config: defineAIConnections({
        appName: "Garage Assistant",
        capabilities: {
          chat: {
            description: "Chat",
            providers: ["openai"],
          },
        },
      }),
      adapters: {
        openai: createMockAdapter("openai", { models: [], failWith: "model_unavailable" }),
      },
      credentials: stores.credentials,
      selections: stores.selectionStore,
      ledger: stores.ledger,
      catalog: withMissing,
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    });
    await expect(
      configRouter.forScope(scope).invoke({
        capability: "chat",
        input: [{ role: "user", text: "secret prompt text" }],
        stream: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(stores.rows[0]?.outcome).toBe("failure");
    expect(stores.rows[0]?.streamed).toBe(true);
    expect(JSON.stringify(stores.rows)).not.toContain("secret prompt text");
  });

  it("streams deltas from the adapter and keeps the prompt out of the ledger", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "openai", "sk-alice-secret-key-123456");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "openai",
      modelId: "openai-mock-chat",
    });
    const events = [];
    for await (const event of routerFor(stores).forScope(scope).invokeStream({
      capability: "chat",
      input: [{ role: "user", text: "secret prompt text" }],
    })) {
      events.push(event);
    }
    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    const joined = deltas.map((event) => (event.type === "delta" ? event.text : "")).join("");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.result.outputText).toBe(joined);
    expect(joined).toContain("secret prompt text");
    expect(stores.rows).toHaveLength(1);
    expect(stores.rows[0]?.streamed).toBe(true);
    expect(stores.rows[0]?.outcome).toBe("success");
    expect(JSON.stringify(stores.rows)).not.toContain("secret prompt text");
    expect(JSON.stringify(stores.rows)).not.toContain("sk-alice-secret-key-123456");
  });

  it("emits one delta when the adapter does not implement invokeStream", async () => {
    const stores = memory();
    await stores.credentials.put(scope, "openai", "valid-key");
    await stores.selectionStore.put(scope, {
      capability: "chat",
      provider: "openai",
      modelId: "openai-mock-chat",
    });
    const mock = createMockAdapter("openai", { models: [catalog[0]!] });
    const adapter = {
      id: mock.id,
      supportedCapabilities: mock.supportedCapabilities,
      testMaySpendQuota: mock.testMaySpendQuota,
      testConnection: (key: string) => mock.testConnection(key),
      listModels: (key: string) => mock.listModels(key),
      invoke: (request: Parameters<typeof mock.invoke>[0], key: string) => mock.invoke(request, key),
    };
    const events = [];
    for await (const event of createRouter({
      config: defineAIConnections({
        appName: "Garage Assistant",
        capabilities: { chat: { description: "Chat", providers: ["openai"], required: true } },
      }),
      adapters: { openai: adapter },
      credentials: stores.credentials,
      selections: stores.selectionStore,
      ledger: stores.ledger,
      catalog,
    }).forScope(scope).invokeStream({
      capability: "chat",
      input: [{ role: "user", text: "Hello" }],
    })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "delta")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(stores.rows[0]?.streamed).toBe(true);
  });
});
