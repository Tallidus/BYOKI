import { randomUUID } from "node:crypto";
import { AIConnectionsError } from "./errors.js";
import { normalizeInput } from "./mock-adapter.js";
import type {
  AIConnectionsConfig,
  Capability,
  CostEstimate,
  InputMessage,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  Scope,
  Selection,
  SelectionStore,
  CredentialStore,
  UsageLedger,
  UsageRecord,
} from "./types.js";

export type RouterDeps = {
  config: AIConnectionsConfig;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  credentials: CredentialStore;
  selections: SelectionStore;
  ledger: UsageLedger;
  catalog: ModelOption[];
  estimateCost?: (args: {
    provider: ProviderId;
    modelId: string;
    usage: UsageRecord["usage"];
  }) => CostEstimate;
  now?: () => Date;
};

export type InvokeBody = {
  capability: Capability;
  input: InputMessage[];
  stream?: boolean;
};

export type InvokeSuccess = {
  outputText: string;
  provider: ProviderId;
  modelId: string;
  providerRequestId?: string;
  usage?: UsageRecord["usage"];
  estimationStatus: "known" | "unknown";
  estimatedCost?: number;
  warning?: string;
};

function monthRange(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

export function findCatalogModel(
  catalog: ModelOption[],
  provider: ProviderId,
  modelId: string,
): ModelOption | undefined {
  return catalog.find((model) => model.provider === provider && model.id === modelId);
}

export function explainSelection(
  config: AIConnectionsConfig,
  catalog: ModelOption[],
  adapters: Partial<Record<ProviderId, ProviderAdapter>>,
  selection: Selection,
): AIConnectionsError | null {
  const policy = config.capabilities[selection.capability];
  if (!policy) {
    return new AIConnectionsError("INVALID_CONFIG", `Capability ${selection.capability} is not declared.`);
  }
  if (!policy.providers.includes(selection.provider)) {
    return new AIConnectionsError(
      "PROVIDER_NOT_ALLOWED",
      `${selection.provider} is not allowed for ${selection.capability}.`,
    );
  }
  const adapter = adapters[selection.provider];
  if (!adapter || !adapter.supportedCapabilities.includes(selection.capability)) {
    return new AIConnectionsError(
      "CAPABILITY_UNSUPPORTED",
      `${selection.provider} does not support ${selection.capability}.`,
    );
  }
  const model = findCatalogModel(catalog, selection.provider, selection.modelId);
  if (!model) {
    return new AIConnectionsError(
      "MODEL_UNAVAILABLE",
      "That model is not in the catalog. Choose another model.",
    );
  }
  if (!model.capabilities.includes(selection.capability)) {
    return new AIConnectionsError(
      "MODEL_INCOMPATIBLE",
      `${selection.modelId} does not support ${selection.capability}.`,
    );
  }
  return null;
}

async function record(
  ledger: UsageLedger,
  record: UsageRecord,
): Promise<void> {
  await ledger.append(record);
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date());

  async function invoke(scope: Scope, body: InvokeBody): Promise<InvokeSuccess> {
    const policy = deps.config.capabilities[body.capability];
    if (!policy) {
      throw new AIConnectionsError("INVALID_CONFIG", `Capability ${body.capability} is not declared.`);
    }
    const selection = await deps.selections.get(scope, body.capability);
    if (!selection) {
      throw new AIConnectionsError(
        "MODEL_UNAVAILABLE",
        `Choose a provider and model for ${body.capability}.`,
      );
    }
    const problem = explainSelection(deps.config, deps.catalog, deps.adapters, selection);
    if (problem) {
      throw problem;
    }
    const adapter = deps.adapters[selection.provider];
    if (!adapter) {
      throw new AIConnectionsError("CAPABILITY_UNSUPPORTED", `No adapter is registered for ${selection.provider}.`);
    }
    const key = await deps.credentials.get(scope, selection.provider);
    if (!key) {
      throw new AIConnectionsError("CREDENTIAL_MISSING", `Connect ${selection.provider} before using ${body.capability}.`);
    }

    let warning: string | undefined;
    const budget = deps.config.limits.budget;
    if (budget?.warnAtUsd !== undefined || budget?.blockAtUsd !== undefined) {
      const range = monthRange(now());
      const rows = await deps.ledger.query(scope, range);
      let observed = 0;
      let hasUnknown = false;
      for (const row of rows) {
        if (row.estimationStatus === "known" && row.estimatedCost !== undefined) {
          observed += row.estimatedCost;
        } else {
          hasUnknown = true;
        }
      }
      if (budget.blockAtUsd !== undefined && observed >= budget.blockAtUsd) {
        throw new AIConnectionsError(
          "BUDGET_BLOCKED",
          "Observed spend in this app is at the best-effort budget. This is not a guaranteed spending cap.",
        );
      }
      if (budget.warnAtUsd !== undefined && observed >= budget.warnAtUsd) {
        warning = hasUnknown
          ? "Observed spend in this app reached the warning threshold. Some calls have unknown cost and are excluded from that total."
          : "Observed spend in this app reached the warning threshold.";
      }
    }

    const started = now().getTime();
    const input = normalizeInput(body.input);
    const maxOutputTokens = deps.config.limits.maxOutputTokens;
    try {
      const result = await adapter.invoke(
        {
          capability: body.capability,
          modelId: selection.modelId,
          input,
          timeoutMs: deps.config.limits.requestTimeoutMs,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        },
        key,
      );
      const estimate = deps.estimateCost?.({
        provider: selection.provider,
        modelId: selection.modelId,
        usage: result.usage,
      }) ?? { status: "unknown" as const, currency: "USD" as const };
      const latencyMs = result.latencyMs || Math.max(0, now().getTime() - started);
      await record(deps.ledger, {
        id: randomUUID(),
        time: now().toISOString(),
        tenantId: scope.tenantId,
        userId: scope.userId,
        capability: body.capability,
        provider: selection.provider,
        modelId: selection.modelId,
        outcome: "success",
        latencyMs,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(estimate.catalogVersion ? { priceCatalogVersion: estimate.catalogVersion } : {}),
        ...(estimate.status === "known" && estimate.amount !== undefined
          ? { estimatedCost: estimate.amount }
          : {}),
        estimationStatus: estimate.status,
        streamed: body.stream === true,
      });
      const outputText = result.output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return {
        outputText,
        provider: selection.provider,
        modelId: selection.modelId,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        estimationStatus: estimate.status,
        ...(estimate.status === "known" && estimate.amount !== undefined
          ? { estimatedCost: estimate.amount }
          : {}),
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      const mapped =
        error instanceof AIConnectionsError
          ? error
          : new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The provider request failed.");
      await record(deps.ledger, {
        id: randomUUID(),
        time: now().toISOString(),
        tenantId: scope.tenantId,
        userId: scope.userId,
        capability: body.capability,
        provider: selection.provider,
        modelId: selection.modelId,
        outcome: "failure",
        latencyMs: Math.max(0, now().getTime() - started),
        ...(mapped.providerRequestId ? { providerRequestId: mapped.providerRequestId } : {}),
        estimationStatus: "unknown",
        errorCode: mapped.code,
        streamed: body.stream === true,
      });
      throw mapped;
    }
  }

  return {
    forScope(scope: Scope) {
      return {
        invoke: (body: InvokeBody) => invoke(scope, body),
      };
    },
  };
}

export type AIRouter = ReturnType<typeof createRouter>;
