import {
  AIConnectionsError,
  TASK_UNSUPPORTED_MESSAGE,
  UPSTREAM_ERROR_MESSAGES,
  connectionTestCategory,
  connectionTestMessage,
  isAIConnectionsError,
  isFixedUpstreamMessage,
  messageForVisitor,
} from "./errors.js";
import { normalizeInput } from "./mock-adapter.js";
import { isModelId, keyFingerprint, mergeDiscoveredModels, type ModelDiscovery } from "./models.js";
import type {
  Capability,
  InputMessage,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  UsageUnits,
} from "./types.js";

export const KEY_TEST_TIMEOUT_MS = 15_000;
export const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
export const MAX_DIRECT_MESSAGES = 32;
export const MAX_DIRECT_PARTS = 8;

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const LOCAL_MESSAGES = {
  emptyKey: "Enter a provider API key.",
  tooManyMessages: "A request can include at most 32 messages.",
  tooManyParts: "A message can include at most 8 parts.",
  dataUrl: "Image data must be raw base64, not a data URL.",
  mime: "Image type must be png, jpeg, webp, or gif.",
  model: "Choose a model.",
} as const;

export type DirectKeyTest =
  | { ok: true; provider: ProviderId }
  | { ok: false; provider: ProviderId | null; category: UpstreamCategory; message: string };

type UpstreamCategory = "invalid_key" | "rate_limited" | "quota" | "unavailable" | "unknown";

export type DirectInvokeInput = {
  apiKey: string;
  /** Must match key-prefix detection when set. */
  provider?: ProviderId;
  modelId: string;
  capability?: Capability;
  input: InputMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type DirectInvokeResult = {
  outputText: string;
  provider: ProviderId;
  modelId: string;
  usage?: UsageUnits;
};

export type DirectStreamEvent = { type: "delta"; text: string } | { type: "done"; result: DirectInvokeResult };

export type DirectClient = {
  detectProvider(apiKey: string): ProviderId | null;
  models(filter?: { provider?: ProviderId; capability?: Capability }): ModelOption[];
  /**
   * Lists models with the user's key. Successful lists are cached for this client
   * instance. A network, CORS, or permission failure returns the developer catalog.
   */
  discoverModels(apiKey: string, options?: { capability?: Capability; refresh?: boolean }): Promise<ModelDiscovery>;
  testKey(apiKey: string): Promise<DirectKeyTest>;
  invoke(input: DirectInvokeInput): Promise<DirectInvokeResult>;
  invokeStream(input: DirectInvokeInput): AsyncIterable<DirectStreamEvent>;
};

export type DirectClientDeps = {
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  catalog: ModelOption[];
};

/**
 * Prefix-only detection. `sk-ant-` is checked before `sk-` so Anthropic keys
 * are not treated as OpenAI. An unrecognized key must not be sent anywhere.
 */
export function detectProvider(apiKey: string): ProviderId | null {
  const key = apiKey.trim();
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "gemini";
  return null;
}

/**
 * Calls the provider HTTPS API from this process. It does not store the key,
 * log it, or attach provider metadata to the result.
 */
type DiscoveryCache = {
  fingerprint: string;
  models: ModelOption[];
  fallback: boolean;
};

export function createDirectClient(deps: DirectClientDeps): DirectClient {
  const cache = new Map<ProviderId, DiscoveryCache>();

  function knownModel(provider: ProviderId, modelId: string): ModelOption | undefined {
    const cached = cache.get(provider)?.models.find((model) => model.id === modelId);
    if (cached) return cached;
    return deps.catalog.find((model) => model.provider === provider && model.id === modelId);
  }

  return {
    detectProvider,
    models(filter) {
      return filterModels(deps.catalog, filter);
    },
    discoverModels(apiKey, options) {
      return discoverModels(deps, cache, apiKey, options);
    },
    testKey(apiKey) {
      return testKey(deps, apiKey);
    },
    invoke(input) {
      return invoke(deps, input, knownModel);
    },
    invokeStream(input) {
      return invokeStream(deps, input, knownModel);
    },
  };
}

function filterModels(models: ModelOption[], filter?: { provider?: ProviderId; capability?: Capability }): ModelOption[] {
  return models.filter((model) => {
    if (filter?.provider && model.provider !== filter.provider) return false;
    if (filter?.capability && !model.capabilities.includes(filter.capability)) return false;
    return true;
  });
}

async function discoverModels(
  deps: DirectClientDeps,
  cache: Map<ProviderId, DiscoveryCache>,
  apiKey: string,
  options?: { capability?: Capability; refresh?: boolean },
): Promise<ModelDiscovery> {
  const key = apiKey.trim();
  const provider = detectProvider(key);
  if (!key || !provider) return { models: [], source: "catalog", fallback: true };
  const fingerprint = keyFingerprint(key);
  const cached = cache.get(provider);
  if (!options?.refresh && cached && cached.fingerprint === fingerprint) {
    return {
      models: filterModels(cached.models, { provider, capability: options?.capability }),
      source: cached.fallback ? "catalog" : "discovered",
      fallback: cached.fallback,
    };
  }
  const catalog = deps.catalog.filter((model) => model.provider === provider);
  const adapter = deps.adapters[provider];
  if (!adapter) {
    cache.set(provider, { fingerprint, models: catalog, fallback: true });
    return { models: filterModels(catalog, { capability: options?.capability }), source: "catalog", fallback: true };
  }
  try {
    const listed = mergeDiscoveredModels(await adapter.listModels(key), catalog);
    cache.set(provider, { fingerprint, models: listed, fallback: false });
    return {
      models: filterModels(listed, { capability: options?.capability }),
      source: "discovered",
      fallback: false,
    };
  } catch {
    cache.set(provider, { fingerprint, models: catalog, fallback: true });
    return { models: filterModels(catalog, { capability: options?.capability }), source: "catalog", fallback: true };
  }
}

async function testKey(deps: DirectClientDeps, apiKey: string): Promise<DirectKeyTest> {
  const key = apiKey.trim();
  const provider = detectProvider(key);
  if (!key || !provider) {
    return { ok: false, provider: null, category: "invalid_key", message: rejectedKeyMessage(key) };
  }
  const adapter = deps.adapters[provider];
  if (!adapter) {
    return { ok: false, provider, category: "unavailable", message: UPSTREAM_ERROR_MESSAGES.unavailable };
  }
  try {
    const result = await adapter.testConnection(key);
    if (result.ok) return { ok: true, provider };
    const category = connectionTestCategory(result) ?? "unknown";
    const message = connectionTestMessage(result) ?? UPSTREAM_ERROR_MESSAGES.unknown;
    return { ok: false, provider, category, message: isFixedUpstreamMessage(message) ? message : UPSTREAM_ERROR_MESSAGES.unknown };
  } catch (error) {
    const parsed = publicError(error);
    return { ok: false, provider, category: categoryFor(parsed), message: parsed.message };
  }
}

async function invoke(
  deps: DirectClientDeps,
  input: DirectInvokeInput,
  knownModel: (provider: ProviderId, modelId: string) => ModelOption | undefined,
): Promise<DirectInvokeResult> {
  const prepared = prepare(deps, input, knownModel);
  try {
    const result = await prepared.adapter.invoke(prepared.request, prepared.key);
    return toResult(prepared.provider, prepared.modelId, textFrom(result.output), result.usage);
  } catch (error) {
    throw publicError(error);
  }
}

async function* invokeStream(
  deps: DirectClientDeps,
  input: DirectInvokeInput,
  knownModel: (provider: ProviderId, modelId: string) => ModelOption | undefined,
): AsyncGenerator<DirectStreamEvent> {
  const prepared = prepare(deps, input, knownModel);
  const source = prepared.adapter.invokeStream
    ? prepared.adapter.invokeStream(prepared.request, prepared.key)
    : bufferAsStream(prepared.adapter, prepared.request, prepared.key);
  let sawDone = false;
  let text = "";
  try {
    for await (const event of source) {
      if (event.type === "delta") {
        text += event.text;
        yield { type: "delta", text: event.text };
        continue;
      }
      sawDone = true;
      const output = textFrom(event.output);
      yield { type: "done", result: toResult(prepared.provider, prepared.modelId, output || text, event.usage) };
    }
  } catch (error) {
    throw publicError(error);
  }
  if (!sawDone) {
    yield { type: "done", result: toResult(prepared.provider, prepared.modelId, text) };
  }
}

type Prepared = {
  key: string;
  provider: ProviderId;
  modelId: string;
  adapter: ProviderAdapter;
  request: ProviderRequest;
};

function prepare(
  deps: DirectClientDeps,
  input: DirectInvokeInput,
  knownModel: (provider: ProviderId, modelId: string) => ModelOption | undefined,
): Prepared {
  const key = input.apiKey.trim();
  const provider = detectProvider(key);
  if (!key) throw new AIConnectionsError("INVALID_KEY", LOCAL_MESSAGES.emptyKey);
  if (!provider) throw new AIConnectionsError("INVALID_KEY", UPSTREAM_ERROR_MESSAGES.invalid_key);
  if (input.provider && input.provider !== provider) {
    throw new AIConnectionsError("INVALID_KEY", UPSTREAM_ERROR_MESSAGES.invalid_key);
  }
  const modelId = input.modelId.trim();
  if (!modelId || !isModelId(modelId) || modelId.includes(key)) {
    throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.model);
  }
  if (input.input.length > MAX_DIRECT_MESSAGES) {
    throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.tooManyMessages);
  }
  if (input.temperature !== undefined && !Number.isFinite(input.temperature)) {
    throw new AIConnectionsError("INVALID_CONFIG", "Temperature must be a finite number.");
  }
  const capability = input.capability ?? "chat";
  if (capability !== "chat" && capability !== "vision") {
    throw new AIConnectionsError("MODEL_INCOMPATIBLE", TASK_UNSUPPORTED_MESSAGE);
  }
  const known = knownModel(provider, modelId);
  const asksForVision = capability === "vision" || input.input.some((message) => message.parts?.some((part) => part.type === "image"));
  if (known && known.capabilities.length > 0) {
    if (!known.capabilities.includes(capability) || (asksForVision && !known.capabilities.includes("vision"))) {
      throw new AIConnectionsError("MODEL_INCOMPATIBLE", TASK_UNSUPPORTED_MESSAGE);
    }
  }
  for (const message of input.input) {
    const count = message.parts?.length ?? (message.text !== undefined ? 1 : 0);
    if (count > MAX_DIRECT_PARTS) throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.tooManyParts);
    for (const part of message.parts ?? []) {
      if (part.type !== "image") continue;
      if (!IMAGE_MIME.has(part.mimeType)) throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.mime);
      if (part.data.trim().toLowerCase().startsWith("data:")) {
        throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.dataUrl);
      }
    }
  }
  const adapter = deps.adapters[provider];
  if (!adapter) throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
  let normalized: ProviderRequest["input"];
  try {
    normalized = normalizeInput(input.input);
  } catch (error) {
    throw publicError(error);
  }
  return {
    key,
    provider,
    modelId,
    adapter,
    request: {
      capability,
      modelId,
      input: normalized,
      timeoutMs: input.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    },
  };
}

async function* bufferAsStream(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  key: string,
): AsyncGenerator<import("./types.js").ProviderStreamEvent> {
  const result = await adapter.invoke(request, key);
  const text = textFrom(result.output);
  if (text) yield { type: "delta", text };
  yield {
    type: "done",
    output: result.output,
    latencyMs: result.latencyMs,
    usageGaps: result.usageGaps,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

function toResult(
  provider: ProviderId,
  modelId: string,
  outputText: string,
  usage?: UsageUnits,
): DirectInvokeResult {
  const copied = copyUsage(usage);
  return { outputText, provider, modelId, ...(copied ? { usage: copied } : {}) };
}

function copyUsage(usage: UsageUnits | undefined): UsageUnits | undefined {
  if (!usage) return undefined;
  const copy: UsageUnits = {};
  if (typeof usage.inputTokens === "number") copy.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") copy.outputTokens = usage.outputTokens;
  if (typeof usage.cacheReadTokens === "number") copy.cacheReadTokens = usage.cacheReadTokens;
  if (typeof usage.cacheWriteTokens === "number") copy.cacheWriteTokens = usage.cacheWriteTokens;
  if (typeof usage.imageCount === "number") copy.imageCount = usage.imageCount;
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function textFrom(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text ?? "")
    .join("\n");
}

function rejectedKeyMessage(key: string): string {
  return key ? UPSTREAM_ERROR_MESSAGES.invalid_key : LOCAL_MESSAGES.emptyKey;
}

function publicError(error: unknown): AIConnectionsError {
  if (isAIConnectionsError(error)) {
    return new AIConnectionsError(error.code, messageForVisitor(error), undefined, error.category);
  }
  return new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
}

function categoryFor(error: AIConnectionsError): UpstreamCategory {
  if (error.category === "invalid_key" || error.category === "rate_limited" || error.category === "quota") {
    return error.category;
  }
  if (error.category === "unavailable" || error.category === "unknown") return error.category;
  if (error.code === "INVALID_KEY") return "invalid_key";
  if (error.code === "RATE_LIMITED") return "rate_limited";
  if (error.code === "UPSTREAM_UNAVAILABLE") return "unavailable";
  return "unknown";
}
