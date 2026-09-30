import {
  AIConnectionsError,
  TRUST_NOTICES,
  explainSelection,
  isCapability,
  isProviderId,
  type AIConnectionsConfig,
  type Capability,
  type CredentialStore,
  type ModelOption,
  type ProviderAdapter,
  type ProviderId,
  type Scope,
  type SelectionStore,
  type UsageLedger,
  type UsageRecord,
} from "@byoki/core";
import type { Logger } from "./redact.js";
import { redact } from "./redact.js";
import type { RateLimiter } from "./rate-limit.js";

export type ProviderLink = {
  keys: string;
  usage: string;
  billing: string;
  reviewedAt: string;
};

export type HandlerDeps = {
  config: AIConnectionsConfig;
  credentials: CredentialStore;
  selections: SelectionStore;
  ledger: UsageLedger;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  catalog: ModelOption[];
  links: Record<ProviderId, ProviderLink>;
  rateLimit: RateLimiter;
  logger: Logger;
  maxBodyBytes?: number;
};

export type AuthContext = {
  scope: Scope | null;
  csrfHeader: string | null;
  expectedCsrf: string | null;
  origin: string | null;
  host: string | null;
};

const KEY_BODY_LIMIT = 8_192;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(error: AIConnectionsError, status = statusFor(error.code)): Response {
  return json(status, { ok: false, error: { code: error.code, message: redact(error.message) } });
}

function statusFor(code: AIConnectionsError["code"]): number {
  switch (code) {
    case "UNAUTHENTICATED":
    case "CSRF_FAILED":
      return 401;
    case "FORBIDDEN":
    case "PROVIDER_NOT_ALLOWED":
      return 403;
    case "CREDENTIAL_MISSING":
    case "MODEL_UNAVAILABLE":
      return 404;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "RATE_LIMITED":
    case "BUDGET_BLOCKED":
      return 429;
    case "INVALID_CONFIG":
    case "MODEL_INCOMPATIBLE":
    case "CAPABILITY_UNSUPPORTED":
    case "INVALID_KEY":
      return 400;
    default:
      return 502;
  }
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new AIConnectionsError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AIConnectionsError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AIConnectionsError("INVALID_CONFIG", "Request body must be JSON.");
  }
}

function requireUser(auth: AuthContext, mutating: boolean): Scope {
  if (!auth.scope) {
    throw new AIConnectionsError("UNAUTHENTICATED", "Sign in to manage AI connections.");
  }
  if (mutating) {
    if (auth.origin && auth.host) {
      let originHost = "";
      try {
        originHost = new URL(auth.origin).host;
      } catch {
        throw new AIConnectionsError("CSRF_FAILED", "The request origin was rejected.");
      }
      if (originHost !== auth.host) {
        throw new AIConnectionsError("CSRF_FAILED", "The request origin was rejected.");
      }
    }
    if (!auth.expectedCsrf || auth.csrfHeader !== auth.expectedCsrf) {
      throw new AIConnectionsError("CSRF_FAILED", "The security token did not match.");
    }
  }
  return auth.scope;
}

function providerFromPath(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new AIConnectionsError("PROVIDER_NOT_ALLOWED", "That provider is not available.");
  }
  return value;
}

function observedSpend(rows: UsageRecord[]): { usd: number; hasUnknown: boolean } {
  let usd = 0;
  let hasUnknown = false;
  for (const row of rows) {
    if (row.estimationStatus === "known" && row.estimatedCost !== undefined) {
      usd += row.estimatedCost;
    } else {
      hasUnknown = true;
    }
  }
  return { usd, hasUnknown };
}

export function createHandlers(deps: HandlerDeps) {
  const maxBody = deps.maxBodyBytes ?? KEY_BODY_LIMIT;

  async function getConnections(auth: AuthContext): Promise<Response> {
    const scope = requireUser(auth, false);
    const selections = await deps.selections.list(scope);
    const providers = (Object.keys(deps.links) as ProviderId[]).map(async (id) => {
      const connected = await deps.credentials.has(scope, id);
      const link = deps.links[id];
      const adapter = deps.adapters[id];
      return {
        id,
        status: connected ? "connected" : "disconnected",
        keyUrl: link.keys,
        usageUrl: link.usage,
        billingUrl: link.billing,
        linksReviewedAt: link.reviewedAt,
        testMaySpendQuota: adapter?.testMaySpendQuota ?? false,
      };
    });
    const capabilities = (Object.entries(deps.config.capabilities) as Array<
      [Capability, NonNullable<(typeof deps.config.capabilities)[Capability]>]
    >).map(([id, policy]) => {
      const selection = selections.find((item) => item.capability === id) ?? null;
      const issue = selection
        ? explainSelection(deps.config, deps.catalog, deps.adapters, selection)
        : null;
      return {
        id,
        description: policy.description,
        required: policy.required,
        userCanChooseModel: policy.userCanChooseModel,
        providers: policy.providers,
        selection,
        selectionIssue: issue ? { code: issue.code, message: issue.message } : null,
      };
    });
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const rows = await deps.ledger.query(scope, {
      from: monthStart.toISOString(),
      to: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)).toISOString(),
    });
    const spend = observedSpend(rows);
    return json(200, {
      ok: true,
      data: {
        appName: deps.config.appName,
        notices: TRUST_NOTICES,
        capabilities,
        providers: await Promise.all(providers),
        limits: deps.config.limits,
        observedSpendUsd: spend.usd,
        observedSpendHasUnknown: spend.hasUnknown,
      },
    });
  }

  async function putConnection(auth: AuthContext, providerRaw: string, request: Request): Promise<Response> {
    const scope = requireUser(auth, true);
    const provider = providerFromPath(providerRaw);
    const body = (await readBody(request, maxBody)) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) {
      throw new AIConnectionsError("INVALID_KEY", "Enter a provider API key.");
    }
    const apiKey = body.apiKey.trim();
    await deps.credentials.put(scope, provider, apiKey);
    deps.logger.info("credential.put", { provider, tenantId: scope.tenantId, userId: scope.userId });
    return json(200, { ok: true, data: { provider, status: "connected" } });
  }

  async function deleteConnection(auth: AuthContext, providerRaw: string): Promise<Response> {
    const scope = requireUser(auth, true);
    const provider = providerFromPath(providerRaw);
    await deps.credentials.delete(scope, provider);
    deps.logger.info("credential.delete", { provider, tenantId: scope.tenantId, userId: scope.userId });
    return json(200, {
      ok: true,
      data: { provider, status: "disconnected", notice: TRUST_NOTICES.localDeletionDoesNotRevoke },
    });
  }

  async function testConnection(auth: AuthContext, providerRaw: string, request: Request): Promise<Response> {
    const scope = requireUser(auth, true);
    const provider = providerFromPath(providerRaw);
    if (!deps.rateLimit.take(`${scope.tenantId}:${scope.userId}:test:${provider}`)) {
      throw new AIConnectionsError("RATE_LIMITED", "Too many connection tests. Wait and try again.");
    }
    const adapter = deps.adapters[provider];
    if (!adapter) {
      throw new AIConnectionsError("CAPABILITY_UNSUPPORTED", `No adapter is registered for ${provider}.`);
    }
    const body = (await readBody(request, maxBody)) as { apiKey?: unknown };
    const submitted = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const key = submitted || (await deps.credentials.get(scope, provider));
    if (!key) {
      throw new AIConnectionsError("CREDENTIAL_MISSING", "Save a key before testing, or submit one with the test.");
    }
    const result = await adapter.testConnection(key);
    return json(200, {
      ok: true,
      data: {
        ok: result.ok,
        ...(result.reason ? { reason: redact(result.reason, [key]) } : {}),
        testMaySpendQuota: adapter.testMaySpendQuota,
      },
    });
  }

  async function getModels(auth: AuthContext, request: Request): Promise<Response> {
    const scope = requireUser(auth, false);
    const url = new URL(request.url);
    const capabilityRaw = url.searchParams.get("capability");
    if (!capabilityRaw || !isCapability(capabilityRaw)) {
      throw new AIConnectionsError("INVALID_CONFIG", "Pass a supported capability.");
    }
    const policy = deps.config.capabilities[capabilityRaw];
    if (!policy) {
      throw new AIConnectionsError("INVALID_CONFIG", `Capability ${capabilityRaw} is not declared.`);
    }
    const discover = url.searchParams.get("discover") === "1";
    const connected = new Set<ProviderId>();
    for (const provider of policy.providers) {
      if (await deps.credentials.has(scope, provider)) connected.add(provider);
    }
    const models = deps.catalog.filter(
      (model) => model.capabilities.includes(capabilityRaw) && connected.has(model.provider),
    );
    const warnings: string[] = [];
    if (discover) {
      for (const provider of policy.providers) {
        if (!deps.rateLimit.take(`${scope.tenantId}:${scope.userId}:discover:${provider}`)) {
          warnings.push(`Model refresh for ${provider} was rate limited.`);
          continue;
        }
        const adapter = deps.adapters[provider];
        if (!adapter || !(await deps.credentials.has(scope, provider))) continue;
        const key = await deps.credentials.get(scope, provider);
        if (!key) continue;
        try {
          const discovered = await adapter.listModels(key);
          for (const model of discovered) {
            if (!model.capabilities.includes(capabilityRaw)) continue;
            if (!models.some((existing) => existing.provider === model.provider && existing.id === model.id)) {
              models.push({ ...model, source: "discovered" });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? redact(error.message, [key]) : "Model refresh failed.";
          warnings.push(message);
        }
      }
    }
    return json(200, { ok: true, data: { models, warnings, caveat: TRUST_NOTICES.capabilityDoesNotLimitKey } });
  }

  async function putSelection(auth: AuthContext, capabilityRaw: string, request: Request): Promise<Response> {
    const scope = requireUser(auth, true);
    if (!isCapability(capabilityRaw)) {
      throw new AIConnectionsError("INVALID_CONFIG", "That capability is not supported.");
    }
    const body = (await readBody(request, maxBody)) as { provider?: unknown; modelId?: unknown };
    if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
      throw new AIConnectionsError("INVALID_CONFIG", "Choose a provider and model.");
    }
    const provider = providerFromPath(body.provider);
    const selection = { capability: capabilityRaw, provider, modelId: body.modelId };
    const problem = explainSelection(deps.config, deps.catalog, deps.adapters, selection);
    if (problem) throw problem;
    if (!(await deps.credentials.has(scope, provider))) {
      throw new AIConnectionsError("CREDENTIAL_MISSING", `Connect ${provider} before selecting it.`);
    }
    await deps.selections.put(scope, selection);
    return json(200, { ok: true, data: selection });
  }

  async function getUsage(auth: AuthContext, request: Request): Promise<Response> {
    const scope = requireUser(auth, false);
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = url.searchParams.get("to") ?? new Date(Date.now() + 60_000).toISOString();
    const rows = await deps.ledger.query(scope, { from, to });
    const spend = observedSpend(rows);
    const byProvider: Record<string, { requests: number; estimatedCost: number | null; hasUnknown: boolean }> = {};
    for (const row of rows) {
      const bucket = byProvider[row.provider] ?? { requests: 0, estimatedCost: 0, hasUnknown: false };
      bucket.requests += 1;
      if (row.estimationStatus === "known" && row.estimatedCost !== undefined && bucket.estimatedCost !== null) {
        bucket.estimatedCost += row.estimatedCost;
      } else {
        bucket.hasUnknown = true;
      }
      byProvider[row.provider] = bucket;
    }
    return json(200, {
      ok: true,
      data: {
        label: TRUST_NOTICES.estimatedInThisApp,
        from,
        to,
        requests: rows.length,
        successes: rows.filter((row) => row.outcome === "success").length,
        failures: rows.filter((row) => row.outcome === "failure").length,
        estimatedCost: spend.hasUnknown ? null : spend.usd,
        estimationStatus: spend.hasUnknown ? "unknown" : "known",
        observedKnownUsd: spend.usd,
        units: rows.map((row) => ({
          time: row.time,
          capability: row.capability,
          provider: row.provider,
          modelId: row.modelId,
          outcome: row.outcome,
          usage: row.usage ?? null,
          estimationStatus: row.estimationStatus,
          estimatedCost: row.estimatedCost ?? null,
          errorCode: row.errorCode ?? null,
        })),
        byProvider,
        budgetNotice: TRUST_NOTICES.budgetIsBestEffort,
      },
    });
  }

  async function dispatch(request: Request, auth: AuthContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const ai = parts.indexOf("ai");
    const tail = ai >= 0 ? parts.slice(ai + 1) : parts;
    try {
      if (tail[0] === "connections" && tail.length === 1 && request.method === "GET") {
        return await getConnections(auth);
      }
      if (tail[0] === "connections" && tail.length === 2 && request.method === "PUT") {
        return await putConnection(auth, tail[1] ?? "", request);
      }
      if (tail[0] === "connections" && tail.length === 2 && request.method === "DELETE") {
        return await deleteConnection(auth, tail[1] ?? "");
      }
      if (tail[0] === "connections" && tail[2] === "test" && request.method === "POST") {
        return await testConnection(auth, tail[1] ?? "", request);
      }
      if (tail[0] === "models" && request.method === "GET") {
        return await getModels(auth, request);
      }
      if (tail[0] === "selections" && tail.length === 2 && request.method === "PUT") {
        return await putSelection(auth, tail[1] ?? "", request);
      }
      if (tail[0] === "usage" && request.method === "GET") {
        return await getUsage(auth, request);
      }
      return json(404, { ok: false, error: { code: "INVALID_CONFIG", message: "Unknown AI route." } });
    } catch (error) {
      if (error instanceof AIConnectionsError) {
        deps.logger.error("ai.request", { code: error.code });
        return fail(error);
      }
      deps.logger.error("ai.request", { code: "UPSTREAM_UNAVAILABLE" });
      return fail(new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The request failed."));
    }
  }

  return { dispatch, getConnections, putConnection, deleteConnection, testConnection, getModels, putSelection, getUsage };
}
