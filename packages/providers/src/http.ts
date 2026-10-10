import {
  AIConnectionsError,
  MODEL_UNAVAILABLE_MESSAGE,
  UPSTREAM_ERROR_MESSAGES,
  type ErrorCode,
  type UpstreamErrorCategory,
} from "@byoki/core";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UpstreamFailure = {
  code: ErrorCode;
  category: UpstreamErrorCategory;
  message: string;
};

const KEY_SIGNALS = new Set([
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "permission_denied",
  "unauthenticated",
  "unauthorized",
]);

const QUOTA_SIGNALS = new Set([
  "insufficient_quota",
  "rate_limit_exceeded",
  "rate_limit_error",
  "resource_exhausted",
  "billing_hard_limit_reached",
  "quota_exceeded",
]);

const UNAVAILABLE_SIGNALS = new Set([
  "overloaded_error",
  "api_error",
  "server_error",
  "unavailable",
  "internal",
  "deadline_exceeded",
  "timeout",
]);

const MODEL_SIGNALS = new Set(["model_not_found", "model_not_available", "not_found_error"]);

export async function providerFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a provider HTTP failure from the status code and structured error
 * code/type/status fields. The response body is not copied into the message,
 * logged, or returned.
 */
export function classifyUpstream(status: number, body: string): UpstreamFailure {
  const signals = signalsFrom(body);
  const has = (set: Set<string>) => signals.some((item) => set.has(item));

  if (status === 401 || status === 403 || has(KEY_SIGNALS)) {
    return failure("INVALID_KEY", "invalid_key");
  }
  if (status === 429 || status === 402 || has(QUOTA_SIGNALS)) {
    return failure("RATE_LIMITED", "rate_limited");
  }
  if (status === 408 || status >= 500 || has(UNAVAILABLE_SIGNALS)) {
    return failure("UPSTREAM_UNAVAILABLE", "unavailable");
  }
  if (status === 404 || has(MODEL_SIGNALS)) {
    return {
      code: "MODEL_UNAVAILABLE",
      category: "unknown",
      message: MODEL_UNAVAILABLE_MESSAGE,
    };
  }
  return failure("UPSTREAM_UNAVAILABLE", "unknown");
}

export async function readUpstreamFailure(response: Response): Promise<UpstreamFailure> {
  const body = await response.text();
  return classifyUpstream(response.status, body);
}

export async function readError(response: Response): Promise<AIConnectionsError> {
  const failure = await readUpstreamFailure(response);
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  return new AIConnectionsError(failure.code, failure.message, requestId);
}

/** Visitor-facing test result. A key test never surfaces model-missing copy or provider text. */
export async function failedConnectionTest(response: Response): Promise<{
  ok: false;
  reason: string;
  category: UpstreamErrorCategory;
}> {
  const failure = await readUpstreamFailure(response);
  if (failure.code === "MODEL_UNAVAILABLE") {
    return { ok: false, reason: UPSTREAM_ERROR_MESSAGES.unknown, category: "unknown" };
  }
  return { ok: false, reason: failure.message, category: failure.category };
}

function failure(code: ErrorCode, category: UpstreamErrorCategory): UpstreamFailure {
  return { code, category, message: UPSTREAM_ERROR_MESSAGES[category] };
}

const SSE_BUFFER_LIMIT = 1_048_576;

/** Read a provider `text/event-stream` body. The payload is not logged. */
export async function* readSse(response: Response): AsyncGenerator<{ event: string; data: string }> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSse(buffer, (next) => {
        buffer = next;
      });
      if (buffer.length > SSE_BUFFER_LIMIT) {
        throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function* drainSse(buffer: string, setBuffer: (next: string) => void): Generator<{ event: string; data: string }> {
  let rest = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const parsed = parseSseBlock(raw);
    if (parsed) yield parsed;
    boundary = rest.indexOf("\n\n");
  }
  setBuffer(rest);
}

function parseSseBlock(raw: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** Parse a provider JSON object. A parse failure becomes a fixed unavailable error. */
export function readJsonRecord(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
  }
  return parsed as Record<string, unknown>;
}

/**
 * If a stream chunk carries a provider error object, throw a fixed visitor error.
 * The provider message is not copied.
 */
export function throwProviderEventError(record: Record<string, unknown>): void {
  const error = record.error;
  if (!error || typeof error !== "object") return;
  const failure = classifyUpstream(0, JSON.stringify({ error }));
  throw new AIConnectionsError(failure.code, failure.message);
}

/**
 * Like `providerFetch`, but the timeout stays armed until `release` so a stalled
 * stream body is aborted. Call `release` when the body has been consumed.
 */
export async function providerStream(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; release: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    controller.abort();
  };
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, release };
  } catch {
    release();
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unavailable);
  }
}

function signalsFrom(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const signals: string[] = [];
  const take = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && value.length <= 80) {
      signals.push(value.toLowerCase());
    }
  };
  const error = root.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    take(record.code);
    take(record.type);
    take(record.status);
  }
  take(root.code);
  take(root.status);
  take(root.type);
  return signals;
}
