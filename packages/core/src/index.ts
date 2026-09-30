export { AIConnectionsError, isAIConnectionsError } from "./errors.js";
export { defineAIConnections, isCapability, isProviderId } from "./config.js";
export type { AIConnectionsInput } from "./config.js";
export { createMockAdapter, normalizeInput } from "./mock-adapter.js";
export { createRouter, explainSelection, findCatalogModel } from "./router.js";
export type { AIRouter, InvokeBody, InvokeSuccess, RouterDeps } from "./router.js";
export {
  AVAILABILITY_CAVEAT,
  CAPABILITIES,
  ERROR_CODES,
  PROVIDER_IDS,
  TRUST_NOTICES,
} from "./types.js";
export type {
  AIConnectionsConfig,
  BudgetPolicy,
  Capability,
  CapabilityPolicy,
  ContentPart,
  CostEstimate,
  CredentialStore,
  ErrorCode,
  InputMessage,
  LedgerOutcome,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResult,
  Scope,
  Selection,
  SelectionStore,
  UsageLedger,
  UsageRecord,
  UsageUnits,
} from "./types.js";
