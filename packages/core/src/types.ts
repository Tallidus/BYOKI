export const CAPABILITIES = ["chat", "vision"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PROVIDER_IDS = ["openai", "anthropic", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ERROR_CODES = [
  "INVALID_CONFIG",
  "PROVIDER_NOT_ALLOWED",
  "CAPABILITY_UNSUPPORTED",
  "MODEL_INCOMPATIBLE",
  "MODEL_UNAVAILABLE",
  "CREDENTIAL_MISSING",
  "INVALID_KEY",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "BUDGET_BLOCKED",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type Scope = {
  tenantId: string;
  userId: string;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type InputMessage = {
  role: "user" | "assistant" | "system";
  text?: string;
  parts?: ContentPart[];
};

export type UsageUnits = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  imageCount?: number;
};

export type ModelOption = {
  id: string;
  provider: ProviderId;
  capabilities: Capability[];
  displayName: string;
  catalogUpdatedAt: string;
  source: "catalog" | "discovered";
  availabilityCaveat: string;
};

export type Selection = {
  capability: Capability;
  provider: ProviderId;
  modelId: string;
};

export type ProviderRequest = {
  capability: Capability;
  modelId: string;
  input: Array<{ role: "user" | "assistant" | "system"; parts: ContentPart[] }>;
  maxOutputTokens?: number;
  timeoutMs: number;
};

export type ProviderResult = {
  status: "success";
  output: ContentPart[];
  providerRequestId?: string;
  latencyMs: number;
  usage?: UsageUnits;
  /** Usage fields this provider cannot supply for the request. */
  usageGaps: string[];
  metadata?: Record<string, unknown>;
};

export type CostEstimate = {
  status: "known" | "unknown";
  currency: "USD";
  amount?: number;
  catalogVersion?: string;
};

export type LedgerOutcome = "success" | "failure";

export type UsageRecord = {
  id: string;
  time: string;
  tenantId: string;
  userId: string;
  capability: Capability;
  provider: ProviderId;
  modelId: string;
  outcome: LedgerOutcome;
  latencyMs: number;
  providerRequestId?: string;
  usage?: UsageUnits;
  priceCatalogVersion?: string;
  estimatedCost?: number;
  estimationStatus: "known" | "unknown";
  errorCode?: ErrorCode;
  streamed: boolean;
};

export interface CredentialStore {
  put(scope: Scope, provider: ProviderId, plaintextKey: string): Promise<void>;
  get(scope: Scope, provider: ProviderId): Promise<string | null>;
  delete(scope: Scope, provider: ProviderId): Promise<void>;
  has(scope: Scope, provider: ProviderId): Promise<boolean>;
}

export interface SelectionStore {
  get(scope: Scope, capability: Capability): Promise<Selection | null>;
  put(scope: Scope, selection: Selection): Promise<void>;
  list(scope: Scope): Promise<Selection[]>;
}

export interface UsageLedger {
  append(record: UsageRecord): Promise<void>;
  query(scope: Scope, range: { from: string; to: string }): Promise<UsageRecord[]>;
}

export interface ProviderAdapter {
  id: ProviderId;
  supportedCapabilities: readonly Capability[];
  testMaySpendQuota: boolean;
  testConnection(key: string): Promise<{ ok: boolean; reason?: string }>;
  listModels(key: string): Promise<ModelOption[]>;
  invoke(request: ProviderRequest, key: string): Promise<ProviderResult>;
}

export type CapabilityPolicy = {
  description: string;
  providers: ProviderId[];
  userCanChooseModel: boolean;
  required: boolean;
};

export type BudgetPolicy = {
  warnAtUsd?: number;
  blockAtUsd?: number;
};

export type AIConnectionsConfig = {
  appName: string;
  capabilities: Partial<Record<Capability, CapabilityPolicy>>;
  limits: {
    maxOutputTokens?: number;
    requestTimeoutMs: number;
    budget?: BudgetPolicy;
  };
};

export const AVAILABILITY_CAVEAT =
  "A listed model is not guaranteed to be enabled for every account. If a call fails, choose another model.";

export const TRUST_NOTICES = {
  capabilityDoesNotLimitKey:
    "A capability only controls routing and this screen. It does not restrict what this API key can do at the provider.",
  hostOperatesKey:
    "This app's server receives your key and the content you submit, and it sends that content to the provider you select.",
  localDeletionDoesNotRevoke:
    "Removing a connection here deletes the key from this app. It does not revoke the key at the provider.",
  estimatedInThisApp:
    "Estimated in this app. Provider account totals can differ because this ledger only includes requests routed through this app.",
  budgetIsBestEffort:
    "Budget checks use observed spend in this app before a call. They cannot see the final token count, and concurrent requests can cross a threshold. This is not a guaranteed spending cap. Set limits in the provider account where they are offered.",
  testMaySpendQuota: "Testing this connection may use provider quota and can incur a charge.",
} as const;
