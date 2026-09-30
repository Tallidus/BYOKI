import { AIConnectionsError, type ErrorCode } from "@byoki/core";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

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
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The provider timed out.");
    }
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The provider could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

export function mapStatus(status: number, body: string, requestId?: string): AIConnectionsError {
  const message = safeUpstream(body);
  let code: ErrorCode = "UPSTREAM_UNAVAILABLE";
  if (status === 401 || status === 403) code = "INVALID_KEY";
  else if (status === 404) code = "MODEL_UNAVAILABLE";
  else if (status === 429) code = "RATE_LIMITED";
  else if (status === 400) code = message.toLowerCase().includes("model") ? "MODEL_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE";
  else if (status >= 500 || status === 408) code = "UPSTREAM_UNAVAILABLE";
  return new AIConnectionsError(code, message || "The provider returned an error.", requestId);
}

export function safeUpstream(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, "[redacted]")
    .slice(0, 240);
}

export async function readError(response: Response): Promise<AIConnectionsError> {
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  const body = await response.text();
  return mapStatus(response.status, body, requestId);
}
