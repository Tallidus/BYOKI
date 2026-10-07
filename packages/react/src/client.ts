import type { Capability, ProviderId, Selection, UpstreamErrorCategory } from "@byoki/core/browser";

export type ConnectionsView = {
  appName: string;
  notices: {
    capabilityDoesNotLimitKey: string;
    hostOperatesKey: string;
    localDeletionDoesNotRevoke: string;
    estimatedInThisApp: string;
    budgetIsBestEffort: string;
    testMaySpendQuota: string;
  };
  capabilities: Array<{
    id: Capability;
    description: string;
    required: boolean;
    userCanChooseModel: boolean;
    providers: ProviderId[];
    selection: Selection | null;
    selectionIssue: { code: string; message: string } | null;
  }>;
  providers: Array<{
    id: ProviderId;
    status: "connected" | "disconnected";
    keyUrl: string;
    usageUrl: string;
    billingUrl: string;
    linksReviewedAt: string;
    testMaySpendQuota: boolean;
  }>;
  limits: {
    maxOutputTokens?: number;
    requestTimeoutMs: number;
    budget?: { warnAtUsd?: number; blockAtUsd?: number };
  };
  observedSpendUsd: number;
  observedSpendHasUnknown: boolean;
};

export type UsageView = {
  label: string;
  from: string;
  to: string;
  requests: number;
  successes: number;
  failures: number;
  estimatedCost: number | null;
  estimationStatus: "known" | "unknown";
  observedKnownUsd: number;
  units: Array<{
    time: string;
    capability: Capability;
    provider: ProviderId;
    modelId: string;
    outcome: string;
    usage: { inputTokens?: number; outputTokens?: number } | null;
    estimationStatus: "known" | "unknown";
    estimatedCost: number | null;
    errorCode: string | null;
  }>;
  budgetNotice: string;
};

export type ModelView = {
  id: string;
  provider: ProviderId;
  capabilities: Capability[];
  displayName: string;
  catalogUpdatedAt: string;
  source: "catalog" | "discovered";
  availabilityCaveat: string;
};

export type ConnectionsClient = {
  getConnections(): Promise<ConnectionsView>;
  putKey(provider: ProviderId, apiKey: string): Promise<void>;
  deleteKey(provider: ProviderId): Promise<void>;
  testKey(
    provider: ProviderId,
    apiKey?: string,
  ): Promise<{ ok: boolean; reason?: string; category?: UpstreamErrorCategory; testMaySpendQuota: boolean }>;
  getModels(capability: Capability, discover?: boolean): Promise<{ models: ModelView[]; warnings: string[] }>;
  putSelection(capability: Capability, provider: ProviderId, modelId: string): Promise<void>;
  getUsage(from: string, to: string): Promise<UsageView>;
};

type ErrorBody = { ok: false; error: { code: string; message: string } };

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: true; data: T } | ErrorBody;
  if (!body.ok) {
    throw new Error(body.error.message);
  }
  return body.data;
}

export function createConnectionsClient(options: { baseUrl: string; csrfToken: string }): ConnectionsClient {
  const headers = { "content-type": "application/json", "x-csrf-token": options.csrfToken };
  const send = (path: string, init?: RequestInit) =>
    fetch(`${options.baseUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers }, credentials: "same-origin" });

  return {
    async getConnections() {
      return parse(await send("/connections"));
    },
    async putKey(provider, apiKey) {
      await parse(await send(`/connections/${provider}`, { method: "PUT", body: JSON.stringify({ apiKey }) }));
    },
    async deleteKey(provider) {
      await parse(await send(`/connections/${provider}`, { method: "DELETE" }));
    },
    async testKey(provider, apiKey) {
      return parse(await send(`/connections/${provider}/test`, { method: "POST", body: JSON.stringify({ apiKey }) }));
    },
    async getModels(capability, discover = false) {
      const query = `capability=${encodeURIComponent(capability)}${discover ? "&discover=1" : ""}`;
      return parse(await send(`/models?${query}`));
    },
    async putSelection(capability, provider, modelId) {
      await parse(await send(`/selections/${capability}`, { method: "PUT", body: JSON.stringify({ provider, modelId }) }));
    },
    async getUsage(from, to) {
      return parse(await send(`/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
    },
  };
}
