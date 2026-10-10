import {
  AIConnectionsError,
  TRUST_NOTICES,
  UPSTREAM_ERROR_MESSAGES,
  connectionTestCategory,
  connectionTestMessage,
  explainSelection,
  isCapability,
  isProviderId,
  messageForVisitor,
  type AIConnectionsConfig,
  type Capability,
  type ContentPart,
  type CredentialStore,
  type InputMessage,
  type InvokeBody,
  type InvokeStreamEvent,
  type InvokeSuccess,
  type ModelOption,
  type ProviderAdapter,
  type ProviderId,
  type Scope,
  type SelectionStore,
  type UsageLedger,
  type UsageRecord,
} from "@byoki/core";
import type { Logger } from "./redact.js";
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
  /** Byte cap for `POST /invoke`. Defaults to 1 MiB. Key routes stay on `maxBodyBytes`. */
  maxInvokeBodyBytes?: number;
  /** Buffered prompt call. Omit to leave `POST /invoke` disabled. */
  invoke?: (scope: Scope, body: InvokeBody) => Promise<InvokeSuccess>;
  /** Token stream used when the invoke body sets `stream: true`. */
  invokeStream?: (scope: Scope, body: InvokeBody) => AsyncIterable<InvokeStreamEvent>;
};

export type AuthTransport = "cookie" | "bearer";

export type AuthContext = {
  scope: Scope | null;
  csrfHeader: string | null;
  expectedCsrf: string | null;
  origin: string | null;
  host: string | null;
  /**
   * `cookie` (default) requires a matching `x-csrf-token` on mutations, and
   * rejects a cross-origin `Origin` when both Origin and Host are present.
   * `bearer` skips those checks. Set it only after the host has authenticated
   * an `Authorization: Bearer` credential. Do not set it for a cookie session:
   * browsers attach cookies on their own, so skipping CSRF would allow a
   * cross-site request to use the session.
   */
  transport?: AuthTransport;
};

const KEY_BODY_LIMIT = 8_192;
const INVOKE_BODY_LIMIT = 1_048_576;
const MAX_MESSAGES = 32;
const MAX_PARTS = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(error: AIConnectionsError, status = statusFor(error.code)): Response {
  return json(status, { ok: false, error: { code: error.code, message: messageForVisitor(error) } });
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
  if (mutating && auth.transport !== "bearer") {
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
    const reason = connectionTestMessage(result);
    const category = connectionTestCategory(result);
    if (!result.ok) {
      deps.logger.error("credential.test", {
        provider,
        tenantId: scope.tenantId,
        userId: scope.userId,
        category: category ?? "unknown",
      });
    }
    return json(200, {
      ok: true,
      data: {
        ok: result.ok,
        ...(reason && category ? { reason, category } : {}),
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
          warnings.push(error instanceof AIConnectionsError ? messageForVisitor(error) : "Model refresh failed.");
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

  async function postInvoke(auth: AuthContext, request: Request): Promise<Response> {
    const scope = requireUser(auth, true);
    if (!deps.invoke || !deps.invokeStream) {
      throw new AIConnectionsError("CAPABILITY_UNSUPPORTED", "Invoke is not enabled on this host.");
    }
    const body = parseInvokeBody(await readBody(request, deps.maxInvokeBodyBytes ?? INVOKE_BODY_LIMIT));
    if (body.stream !== true) {
      const result = await deps.invoke(scope, { capability: body.capability, input: body.input, stream: false });
      return json(200, { ok: true, data: result });
    }
    const iterator = deps.invokeStream(scope, { capability: body.capability, input: body.input, stream: true })[
      Symbol.asyncIterator
    ]();
    let first: IteratorResult<InvokeStreamEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      if (typeof iterator.return === "function") await iterator.return().catch(() => undefined);
      throw error;
    }
    if (first.done) {
      return fail(new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown));
    }
    const encoder = new TextEncoder();
    const firstEvent = first.value;
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          writeStreamEvent(send, firstEvent);
          while (!closed) {
            const next = await iterator.next();
            if (next.done || closed) break;
            writeStreamEvent(send, next.value);
          }
        } catch (error) {
          const mapped =
            error instanceof AIConnectionsError
              ? error
              : new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown);
          deps.logger.error("ai.invoke", { code: mapped.code });
          try {
            send("error", { ok: false, error: { code: mapped.code, message: messageForVisitor(mapped) } });
          } catch {
            closed = true;
          }
        } finally {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // The client already went away.
            }
          }
        }
      },
      cancel() {
        closed = true;
        if (typeof iterator.return === "function") void iterator.return();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
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
      if (tail[0] === "invoke" && tail.length === 1 && request.method === "POST") {
        return await postInvoke(auth, request);
      }
      return json(404, { ok: false, error: { code: "INVALID_CONFIG", message: "Unknown AI route." } });
    } catch (error) {
      if (error instanceof AIConnectionsError) {
        deps.logger.error("ai.request", { code: error.code });
        return fail(error);
      }
      deps.logger.error("ai.request", { code: "UPSTREAM_UNAVAILABLE" });
      return fail(new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown));
    }
  }

  return { dispatch, getConnections, putConnection, deleteConnection, testConnection, getModels, putSelection, getUsage };
}

function writeStreamEvent(send: (event: string, data: unknown) => void, event: InvokeStreamEvent): void {
  if (event.type === "delta") {
    send("delta", { text: event.text });
    return;
  }
  send("done", { ok: true, data: event.result });
}

function parseInvokeBody(value: unknown): InvokeBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIConnectionsError("INVALID_CONFIG", "Request body must be JSON.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.capability !== "string" || !isCapability(body.capability)) {
    throw new AIConnectionsError("INVALID_CONFIG", "Choose chat or vision.");
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    throw new AIConnectionsError("INVALID_CONFIG", "Include a message.");
  }
  if (body.input.length > MAX_MESSAGES) {
    throw new AIConnectionsError("INVALID_CONFIG", "Include at most 32 messages.");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new AIConnectionsError("INVALID_CONFIG", "stream must be a boolean.");
  }
  const input = body.input.map((item) => parseMessage(item));
  return {
    capability: body.capability,
    input,
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
  };
}

function parseMessage(value: unknown): InputMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIConnectionsError("INVALID_CONFIG", "Each message must be an object.");
  }
  const message = value as Record<string, unknown>;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
    throw new AIConnectionsError("INVALID_CONFIG", "Message role must be user, assistant, or system.");
  }
  let text: string | undefined;
  if (message.text !== undefined) {
    if (typeof message.text !== "string" || message.text.length === 0) {
      throw new AIConnectionsError("INVALID_CONFIG", "Message text must be a non-empty string.");
    }
    text = message.text;
  }
  let parts: ContentPart[] | undefined;
  if (message.parts !== undefined) {
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      throw new AIConnectionsError("INVALID_CONFIG", "Each message needs text or parts.");
    }
    if (message.parts.length > MAX_PARTS) {
      throw new AIConnectionsError("INVALID_CONFIG", "Include at most 8 parts in a message.");
    }
    parts = message.parts.map((part) => parsePart(part));
  }
  if (text === undefined && parts === undefined) {
    throw new AIConnectionsError("INVALID_CONFIG", "Each message needs text or parts.");
  }
  return {
    role: message.role,
    ...(text !== undefined ? { text } : {}),
    ...(parts ? { parts } : {}),
  };
}

function parsePart(value: unknown): ContentPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIConnectionsError("INVALID_CONFIG", "Each message needs text or parts.");
  }
  const part = value as Record<string, unknown>;
  if (part.type === "text") {
    if (typeof part.text !== "string" || part.text.length === 0) {
      throw new AIConnectionsError("INVALID_CONFIG", "Message text must be a non-empty string.");
    }
    return { type: "text", text: part.text };
  }
  if (part.type === "image") {
    if (typeof part.mimeType !== "string" || !IMAGE_TYPES.has(part.mimeType)) {
      throw new AIConnectionsError("INVALID_CONFIG", "Image type must be png, jpeg, webp, or gif.");
    }
    if (typeof part.data !== "string" || part.data.length === 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(part.data)) {
      throw new AIConnectionsError("INVALID_CONFIG", "Image data must be base64, without a data: prefix.");
    }
    return { type: "image", mimeType: part.mimeType, data: part.data };
  }
  throw new AIConnectionsError("INVALID_CONFIG", "Each message needs text or parts.");
}
