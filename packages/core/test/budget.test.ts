import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/mock-adapter.js";
import { createRouter } from "../src/router.js";
import { defineAIConnections } from "../src/config.js";
import type { CredentialStore, ModelOption, Scope, Selection, SelectionStore, UsageLedger, UsageRecord } from "../src/types.js";

const scope: Scope = { tenantId: "local", userId: "user-a" };
const model: ModelOption = {
  id: "openai-mock-chat",
  provider: "openai",
  capabilities: ["chat"],
  displayName: "Mock",
  catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
  source: "catalog",
  availabilityCaveat: "May be unavailable.",
};

describe("best-effort budgets", () => {
  it("lets concurrent calls pass a preflight that cannot see in-flight spend", async () => {
    const keys = new Map<string, string>([["openai", "valid-key"]]);
    const selection: Selection = { capability: "chat", provider: "openai", modelId: model.id };
    let rows: UsageRecord[] = [];
    const credentials: CredentialStore = {
      async put() {},
      async get(_scope, provider) {
        return keys.get(provider) ?? null;
      },
      async delete() {},
      async has(_scope, provider) {
        return keys.has(provider);
      },
    };
    const selections: SelectionStore = {
      async get() {
        return selection;
      },
      async put() {},
      async list() {
        return [selection];
      },
    };
    const ledger: UsageLedger = {
      async append(record) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rows = [...rows, record];
      },
      async query() {
        return rows;
      },
    };
    const router = createRouter({
      config: defineAIConnections({
        appName: "Garage Assistant",
        capabilities: { chat: { description: "Chat", providers: ["openai"] } },
        limits: { budget: { blockAtUsd: 0.01 } },
      }),
      adapters: { openai: createMockAdapter("openai", { models: [model] }) },
      credentials,
      selections,
      ledger,
      catalog: [model],
      estimateCost: () => ({ status: "known", currency: "USD", amount: 0.01, catalogVersion: "test" }),
      now: () => new Date("2026-09-25T12:00:00.000Z"),
    });
    const results = await Promise.allSettled([
      router.forScope(scope).invoke({ capability: "chat", input: [{ role: "user", text: "one" }] }),
      router.forScope(scope).invoke({ capability: "chat", input: [{ role: "user", text: "two" }] }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
