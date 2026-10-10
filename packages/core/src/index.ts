export {
  AIConnectionsError,
  MODEL_UNAVAILABLE_MESSAGE,
  UPSTREAM_ERROR_MESSAGES,
  connectionTestCategory,
  connectionTestMessage,
  isAIConnectionsError,
  isFixedUpstreamMessage,
  isUpstreamErrorCategory,
  messageForVisitor,
  scrubVisitorText,
} from "./errors.js";
export { defineAIConnections, isCapability, isProviderId } from "./config.js";
export type { AIConnectionsInput } from "./config.js";
export { createMockAdapter, normalizeInput } from "./mock-adapter.js";
export { createRouter, explainSelection, findCatalogModel } from "./router.js";
export {
  DEFAULT_INVOKE_TIMEOUT_MS,
  KEY_TEST_TIMEOUT_MS,
  MAX_DIRECT_MESSAGES,
  MAX_DIRECT_PARTS,
  createDirectClient,
  detectProvider,
} from "./direct.js";
export type { DirectClient, DirectInvokeInput, DirectInvokeResult, DirectKeyTest, DirectStreamEvent } from "./direct.js";
export type { AIRouter, InvokeBody, InvokeStreamEvent, InvokeSuccess, RouterDeps } from "./router.js";
export {
  AVAILABILITY_CAVEAT,
  CAPABILITIES,
  ERROR_CODES,
  PROVIDER_IDS,
  TRUST_NOTICES,
  UPSTREAM_ERROR_CATEGORIES,
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
  UpstreamErrorCategory,
  LedgerOutcome,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResult,
  ProviderStreamEvent,
  Scope,
  Selection,
  SelectionStore,
  UsageLedger,
  UsageRecord,
  UsageUnits,
} from "./types.js";
