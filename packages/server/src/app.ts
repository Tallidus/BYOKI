import { join } from "node:path";
import {
  createRouter,
  type AIConnectionsConfig,
  type CostEstimate,
  type CredentialStore,
  type ModelOption,
  type ProviderAdapter,
  type ProviderId,
  type SelectionStore,
  type UsageLedger,
  type UsageUnits,
} from "@byoki/core";
import { decodeMasterKey } from "./crypto.js";
import { createEncryptedFileStore } from "./file-store.js";
import { createHandlers, type ProviderLink } from "./handlers.js";
import { createRateLimiter } from "./rate-limit.js";
import { createRedactingLogger, type Logger } from "./redact.js";

export type AIConnectionsAppOptions = {
  config: AIConnectionsConfig;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  catalog: ModelOption[];
  links: Record<ProviderId, ProviderLink>;
  estimateCost: (args: {
    provider: ProviderId;
    modelId: string;
    usage: UsageUnits | undefined;
  }) => CostEstimate;
  /** Required unless credentials, selections, and ledger are all provided. */
  masterKey?: string;
  dataFile?: string;
  credentials?: CredentialStore;
  selections?: SelectionStore;
  ledger?: UsageLedger;
  logger?: Logger;
};

/**
 * Wires the router and settings handlers for one host process.
 * Pass your own stores in production. Omit them in development to use the
 * encrypted file store and BYOKI_MASTER_KEY.
 */
export function createAIConnectionsApp(options: AIConnectionsAppOptions) {
  const stores = resolveStores(options);
  const logger = options.logger ?? createRedactingLogger((line) => console.info(line));
  const shared = {
    config: options.config,
    adapters: options.adapters,
    credentials: stores.credentials,
    selections: stores.selections,
    ledger: stores.ledger,
    catalog: options.catalog,
  };
  return {
    config: options.config,
    router: createRouter({
      ...shared,
      estimateCost: options.estimateCost,
    }),
    handlers: createHandlers({
      ...shared,
      links: options.links,
      rateLimit: createRateLimiter(20, 60_000),
      logger,
    }),
  };
}

function resolveStores(options: AIConnectionsAppOptions) {
  if (options.credentials && options.selections && options.ledger) {
    return {
      credentials: options.credentials,
      selections: options.selections,
      ledger: options.ledger,
    };
  }
  const masterKey = options.masterKey ?? process.env.BYOKI_MASTER_KEY;
  if (!masterKey?.trim()) {
    throw new Error(
      "BYOKI_MASTER_KEY is required for the development file store. Production hosts pass credentials, selections, and ledger instead.",
    );
  }
  const file = createEncryptedFileStore(
    options.dataFile ?? join(process.cwd(), ".data", "byoki-store.json"),
    decodeMasterKey(masterKey),
  );
  return {
    credentials: options.credentials ?? file.credentials,
    selections: options.selections ?? file.selections,
    ledger: options.ledger ?? file.ledger,
  };
}
