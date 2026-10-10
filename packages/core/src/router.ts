import { AIConnectionsError, UPSTREAM_ERROR_MESSAGES } from "./errors.js";
import { normalizeInput } from "./mock-adapter.js";
import type {
  AIConnectionsConfig,
  Capability,
  ContentPart,
  CostEstimate,
  InputMessage,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderStreamEvent,
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

/** Events from `invokeStream`. `done.result` matches a buffered `invoke` success. */
export type InvokeStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; result: InvokeSuccess };

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.randomUUID) {
    throw new AIConnectionsError("INVALID_CONFIG", "This runtime cannot create a request id.");
  }
  return cryptoApi.randomUUID();
}

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

type PreparedCall = {
  selection: Selection;
  adapter: ProviderAdapter;
  key: string;
  warning?: string;
};

function textFromParts(parts: ContentPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function providerRequest(config: AIConnectionsConfig, body: InvokeBody, selection: Selection): ProviderRequest {
  const input = normalizeInput(body.input);
  const maxOutputTokens = config.limits.maxOutputTokens;
  return {
    capability: body.capability,
    modelId: selection.modelId,
    input,
    timeoutMs: config.limits.requestTimeoutMs,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

async function* bufferedStream(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  key: string,
): AsyncGenerator<ProviderStreamEvent> {
  const result = await adapter.invoke(request, key);
  const text = textFromParts(result.output);
  if (text) yield { type: "delta", text };
  yield {
    type: "done",
    output: result.output,
    ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
    latencyMs: result.latencyMs,
    ...(result.usage ? { usage: result.usage } : {}),
    usageGaps: result.usageGaps,
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date());

  async function prepare(scope: Scope, body: InvokeBody): Promise<PreparedCall> {
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

    return { selection, adapter, key, ...(warning ? { warning } : {}) };
  }

  function successResult(
    prepared: PreparedCall,
    fields: {
      output: ContentPart[];
      providerRequestId?: string;
      usage?: UsageRecord["usage"];
      estimationStatus: "known" | "unknown";
      estimatedCost?: number;
    },
  ): InvokeSuccess {
    return {
      outputText: textFromParts(fields.output),
      provider: prepared.selection.provider,
      modelId: prepared.selection.modelId,
      ...(fields.providerRequestId ? { providerRequestId: fields.providerRequestId } : {}),
      ...(fields.usage ? { usage: fields.usage } : {}),
      estimationStatus: fields.estimationStatus,
      ...(fields.estimationStatus === "known" && fields.estimatedCost !== undefined
        ? { estimatedCost: fields.estimatedCost }
        : {}),
      ...(prepared.warning ? { warning: prepared.warning } : {}),
    };
  }

  async function ledgerSuccess(
    scope: Scope,
    prepared: PreparedCall,
    streamed: boolean,
    fields: {
      latencyMs: number;
      providerRequestId?: string;
      usage?: UsageRecord["usage"];
      estimate: CostEstimate;
    },
  ): Promise<void> {
    await record(deps.ledger, {
      id: randomId(),
      time: now().toISOString(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      capability: prepared.selection.capability,
      provider: prepared.selection.provider,
      modelId: prepared.selection.modelId,
      outcome: "success",
      latencyMs: fields.latencyMs,
      ...(fields.providerRequestId ? { providerRequestId: fields.providerRequestId } : {}),
      ...(fields.usage ? { usage: fields.usage } : {}),
      ...(fields.estimate.catalogVersion ? { priceCatalogVersion: fields.estimate.catalogVersion } : {}),
      ...(fields.estimate.status === "known" && fields.estimate.amount !== undefined
        ? { estimatedCost: fields.estimate.amount }
        : {}),
      estimationStatus: fields.estimate.status,
      streamed,
    });
  }

  async function ledgerFailure(
    scope: Scope,
    prepared: PreparedCall,
    streamed: boolean,
    started: number,
    error: AIConnectionsError,
  ): Promise<void> {
    await record(deps.ledger, {
      id: randomId(),
      time: now().toISOString(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      capability: prepared.selection.capability,
      provider: prepared.selection.provider,
      modelId: prepared.selection.modelId,
      outcome: "failure",
      latencyMs: Math.max(0, now().getTime() - started),
      ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
      estimationStatus: "unknown",
      errorCode: error.code,
      streamed,
    });
  }

  function estimateFor(prepared: PreparedCall, usage: UsageRecord["usage"]): CostEstimate {
    return (
      deps.estimateCost?.({
        provider: prepared.selection.provider,
        modelId: prepared.selection.modelId,
        usage,
      }) ?? { status: "unknown" as const, currency: "USD" as const }
    );
  }

  async function invoke(scope: Scope, body: InvokeBody): Promise<InvokeSuccess> {
    const prepared = await prepare(scope, body);
    const started = now().getTime();
    try {
      const result = await prepared.adapter.invoke(
        providerRequest(deps.config, body, prepared.selection),
        prepared.key,
      );
      const estimate = estimateFor(prepared, result.usage);
      const latencyMs = result.latencyMs || Math.max(0, now().getTime() - started);
      await ledgerSuccess(scope, prepared, body.stream === true, {
        latencyMs,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        estimate,
      });
      return successResult(prepared, {
        output: result.output,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        estimationStatus: estimate.status,
        ...(estimate.status === "known" && estimate.amount !== undefined ? { estimatedCost: estimate.amount } : {}),
      });
    } catch (error) {
      const mapped =
        error instanceof AIConnectionsError
          ? error
          : new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown);
      await ledgerFailure(scope, prepared, body.stream === true, started, mapped);
      throw mapped;
    }
  }

  /**
   * Yields text deltas and then one done event. Failures before the first
   * delta throw. A failure after a delta throws as well, after the ledger row
   * is written. Calling this records `streamed: true`.
   */
  async function* invokeStream(scope: Scope, body: InvokeBody): AsyncGenerator<InvokeStreamEvent> {
    const prepared = await prepare(scope, body);
    const started = now().getTime();
    const request = providerRequest(deps.config, body, prepared.selection);
    try {
      const source = prepared.adapter.invokeStream
        ? prepared.adapter.invokeStream(request, prepared.key)
        : bufferedStream(prepared.adapter, request, prepared.key);
      let providerDone: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      let accumulated = "";
      for await (const event of source) {
        if (event.type === "delta") {
          if (!event.text) continue;
          accumulated += event.text;
          yield { type: "delta", text: event.text };
        } else {
          providerDone = event;
        }
      }
      const output = providerDone?.output ?? [{ type: "text" as const, text: accumulated }];
      const usage = providerDone?.usage;
      const estimate = estimateFor(prepared, usage);
      const latencyMs = providerDone?.latencyMs || Math.max(0, now().getTime() - started);
      await ledgerSuccess(scope, prepared, true, {
        latencyMs,
        ...(providerDone?.providerRequestId ? { providerRequestId: providerDone.providerRequestId } : {}),
        ...(usage ? { usage } : {}),
        estimate,
      });
      yield {
        type: "done",
        result: successResult(prepared, {
          output,
          ...(providerDone?.providerRequestId ? { providerRequestId: providerDone.providerRequestId } : {}),
          ...(usage ? { usage } : {}),
          estimationStatus: estimate.status,
          ...(estimate.status === "known" && estimate.amount !== undefined ? { estimatedCost: estimate.amount } : {}),
        }),
      };
    } catch (error) {
      const mapped =
        error instanceof AIConnectionsError
          ? error
          : new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown);
      await ledgerFailure(scope, prepared, true, started, mapped);
      throw mapped;
    }
  }

  return {
    forScope(scope: Scope) {
      return {
        invoke: (body: InvokeBody) => invoke(scope, body),
        invokeStream: (body: InvokeBody) => invokeStream(scope, body),
      };
    },
  };
}

export type AIRouter = ReturnType<typeof createRouter>;
