import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createMockAdapter,
  defineAIConnections,
  PROVIDER_IDS,
  type ProviderAdapter,
  type ProviderId,
  type Scope,
} from "@byoki/core";
import { PRICE_CATALOG, estimateCost } from "@byoki/pricing";
import { MANUAL_CATALOG, PROVIDER_LINKS, createProviderAdapters } from "@byoki/providers";
import { createAIConnectionsApp, createEncryptedFileStore, decodeMasterKey } from "@byoki/server";
import { isMockMode, storeMode } from "./env";
import { TENANT_ID } from "./session";
import { createVisitorMemory, type VisitorMemory } from "./stores";

const config = defineAIConnections({
  appName: "BYOKI Demo",
  capabilities: {
    chat: {
      description: "Sends a prompt with the provider key connected for this session.",
      providers: ["openai", "anthropic", "gemini"],
      userCanChooseModel: true,
      required: true,
    },
    vision: {
      description: "Sends a prompt and an image with the provider key connected for this session.",
      providers: ["openai", "gemini"],
      userCanChooseModel: true,
      required: false,
    },
  },
  limits: {
    maxOutputTokens: 512,
    requestTimeoutMs: 30_000,
    budget: { warnAtUsd: 1, blockAtUsd: 5 },
  },
});

function adapters(): Record<ProviderId, ProviderAdapter> {
  if (isMockMode()) {
    return {
      openai: createMockAdapter("openai", { models: MANUAL_CATALOG.filter((model) => model.provider === "openai") }),
      anthropic: createMockAdapter("anthropic", {
        models: MANUAL_CATALOG.filter((model) => model.provider === "anthropic"),
      }),
      gemini: createMockAdapter("gemini", { models: MANUAL_CATALOG.filter((model) => model.provider === "gemini") }),
    };
  }
  return createProviderAdapters();
}

type Runtime = {
  app: ReturnType<typeof createAIConnectionsApp>;
  activate(scope: Scope, expiresAt: number): Promise<void>;
  forget(scope: Scope): Promise<void>;
};

let runtime: Runtime | null = null;

function expiryFile(): string {
  return path.join(process.cwd(), ".data", "visitor-expiry.json");
}

function readExpiry(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(expiryFile(), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeExpiry(data: Record<string, number>): void {
  const file = expiryFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data), "utf8");
}

function createRuntime(): Runtime {
  if (storeMode() === "memory") {
    const memory: VisitorMemory = createVisitorMemory();
    const app = createAIConnectionsApp({
      config,
      adapters: adapters(),
      catalog: MANUAL_CATALOG,
      links: PROVIDER_LINKS,
      estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
      credentials: memory.credentials,
      selections: memory.selections,
      ledger: memory.ledger,
    });
    return {
      app,
      async activate(scope, expiresAt) {
        memory.activate(scope, expiresAt);
      },
      async forget(scope) {
        memory.forget(scope);
      },
    };
  }

  const masterKey = process.env.BYOKI_MASTER_KEY;
  if (!masterKey?.trim()) {
    throw new Error("BYOKI_MASTER_KEY is required when BYOKI_STORE=file.");
  }
  const file = createEncryptedFileStore(path.join(process.cwd(), ".data", "store.json"), decodeMasterKey(masterKey));
  const app = createAIConnectionsApp({
    config,
    adapters: adapters(),
    catalog: MANUAL_CATALOG,
    links: PROVIDER_LINKS,
    estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
    credentials: file.credentials,
    selections: file.selections,
    ledger: file.ledger,
  });
  async function deleteCredentials(scope: Scope): Promise<void> {
    await Promise.all(PROVIDER_IDS.map((provider) => file.credentials.delete(scope, provider)));
  }

  return {
    app,
    async activate(scope, expiresAt) {
      const data = readExpiry();
      const now = Date.now();
      for (const [id, exp] of Object.entries(data)) {
        if (exp > now) continue;
        delete data[id];
        const [tenantId, userId] = id.split(":");
        if (tenantId && userId) await deleteCredentials({ tenantId, userId });
      }
      const key = `${scope.tenantId}:${scope.userId}`;
      if (expiresAt <= now) delete data[key];
      else data[key] = expiresAt;
      writeExpiry(data);
    },
    async forget(scope) {
      await deleteCredentials(scope);
      const data = readExpiry();
      delete data[`${scope.tenantId}:${scope.userId}`];
      writeExpiry(data);
    },
  };
}

function current(): Runtime {
  if (!runtime) runtime = createRuntime();
  return runtime;
}

export function getServices() {
  return current().app;
}

export function activateVisitor(scope: Scope, expiresAt: number): Promise<void> {
  return current().activate({ tenantId: scope.tenantId || TENANT_ID, userId: scope.userId }, expiresAt);
}

export function forgetVisitor(scope: Scope): Promise<void> {
  return current().forget(scope);
}
