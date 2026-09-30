import path from "node:path";
import { createMockAdapter, defineAIConnections, type ProviderAdapter, type ProviderId } from "@byoki/core";
import { PRICE_CATALOG, estimateCost } from "@byoki/pricing";
import { MANUAL_CATALOG, PROVIDER_LINKS, createProviderAdapters } from "@byoki/providers";
import { createAIConnectionsApp } from "@byoki/server";

const config = defineAIConnections({
  appName: "Garage Assistant",
  capabilities: {
    chat: {
      description: "Answers questions about vehicle repairs.",
      providers: ["openai", "anthropic", "gemini"],
      userCanChooseModel: true,
      required: true,
    },
    vision: {
      description: "Analyzes photos you submit.",
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
  if (process.env.BYOKI_USE_MOCK === "1") {
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

let cached: ReturnType<typeof createAIConnectionsApp> | null = null;

export function getServices() {
  if (!cached) {
    cached = createAIConnectionsApp({
      config,
      adapters: adapters(),
      catalog: MANUAL_CATALOG,
      links: PROVIDER_LINKS,
      estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
      dataFile: path.join(process.cwd(), ".data", "store.json"),
    });
  }
  return cached;
}
