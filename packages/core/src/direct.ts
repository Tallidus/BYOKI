import {
  AIConnectionsError,
  UPSTREAM_ERROR_MESSAGES,
  connectionTestCategory,
  connectionTestMessage,
  isAIConnectionsError,
  isFixedUpstreamMessage,
  messageForVisitor,
} from "./errors.js";
import { normalizeInput } from "./mock-adapter.js";
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
const MODEL_ID = /^[A-Za-z0-9._:-]+$/;

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
export function createDirectClient(deps: DirectClientDeps): DirectClient {
  return {
    detectProvider,
    models(filter) {
      return deps.catalog.filter((model) => {
        if (filter?.provider && model.provider !== filter.provider) return false;
        if (filter?.capability && !model.capabilities.includes(filter.capability)) return false;
        return true;
      });
    },
    testKey(apiKey) {
      return testKey(deps, apiKey);
    },
    invoke(input) {
      return invoke(deps, input);
    },
    invokeStream(input) {
      return invokeStream(deps, input);
    },
  };
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

async function invoke(deps: DirectClientDeps, input: DirectInvokeInput): Promise<DirectInvokeResult> {
  const prepared = prepare(deps, input);
  try {
    const result = await prepared.adapter.invoke(prepared.request, prepared.key);
    return toResult(prepared.provider, prepared.modelId, textFrom(result.output), result.usage);
  } catch (error) {
    throw publicError(error);
  }
}

async function* invokeStream(deps: DirectClientDeps, input: DirectInvokeInput): AsyncGenerator<DirectStreamEvent> {
  const prepared = prepare(deps, input);
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

function prepare(deps: DirectClientDeps, input: DirectInvokeInput): Prepared {
  const key = input.apiKey.trim();
  const provider = detectProvider(key);
  if (!key) throw new AIConnectionsError("INVALID_KEY", LOCAL_MESSAGES.emptyKey);
  if (!provider) throw new AIConnectionsError("INVALID_KEY", UPSTREAM_ERROR_MESSAGES.invalid_key);
  if (input.provider && input.provider !== provider) {
    throw new AIConnectionsError("INVALID_KEY", UPSTREAM_ERROR_MESSAGES.invalid_key);
  }
  const modelId = input.modelId.trim();
  if (!modelId || !MODEL_ID.test(modelId) || modelId.includes(key)) {
    throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.model);
  }
  if (input.input.length > MAX_DIRECT_MESSAGES) {
    throw new AIConnectionsError("INVALID_CONFIG", LOCAL_MESSAGES.tooManyMessages);
  }
  const capability = input.capability ?? "chat";
  if (capability !== "chat" && capability !== "vision") {
    throw new AIConnectionsError("INVALID_CONFIG", "Choose a chat or vision request.");
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
