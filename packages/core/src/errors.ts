import { UPSTREAM_ERROR_CATEGORIES, type ErrorCode, type UpstreamErrorCategory } from "./types.js";

export class AIConnectionsError extends Error {
  readonly code: ErrorCode;
  readonly providerRequestId?: string;

  constructor(code: ErrorCode, message: string, providerRequestId?: string) {
    super(message);
    this.name = "AIConnectionsError";
    this.code = code;
    if (providerRequestId !== undefined) {
      this.providerRequestId = providerRequestId;
    }
  }
}

export function isAIConnectionsError(error: unknown): error is AIConnectionsError {
  return error instanceof AIConnectionsError;
}

/**
 * Fixed visitor copy for upstream failures. These strings are the only text a
 * key test or provider error may show. They never include provider bodies,
 * key material, request ids, or headers.
 */
export const UPSTREAM_ERROR_MESSAGES: Record<UpstreamErrorCategory, string> = {
  invalid_key: "The provider rejected this key. Check the key and try again.",
  rate_limited: "The provider rate limit or quota was reached. Wait and try again.",
  unavailable: "The provider is unavailable or the request timed out. Try again later.",
  unknown: "The provider request failed. Try again.",
};

export const MODEL_UNAVAILABLE_MESSAGE = "That model is not available. Choose another model.";

const LOCAL_INVALID_KEY = "Enter a provider API key.";
const LOCAL_RATE_LIMIT = "Too many connection tests. Wait and try again.";
const LOCAL_MODEL_MESSAGES = new Set<string>([
  MODEL_UNAVAILABLE_MESSAGE,
  "That model is not in the catalog. Choose another model.",
  "That model is not available for this account. Choose another model.",
]);

const LEAK = /sk-[A-Za-z0-9*_-]*|AIza[0-9A-Za-z*_-]*|\*{3,}|x-request-id|\brequest-id\b|authorization\s*:|bearer\s+\S/i;

const CATEGORY_SET = new Set<string>(UPSTREAM_ERROR_CATEGORIES);

/** Reasons shipped before category was set. They are not provider text. */
const LEGACY_TEST_REASONS: Record<string, UpstreamErrorCategory> = {
  "The provider rejected this key.": "invalid_key",
};

export function isUpstreamErrorCategory(value: unknown): value is UpstreamErrorCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

export function isFixedUpstreamMessage(message: string): boolean {
  return (Object.values(UPSTREAM_ERROR_MESSAGES) as string[]).includes(message);
}

/**
 * Replace text that could carry a provider body or key echo.
 * Safe, authored messages pass through.
 */
export function scrubVisitorText(message: string, fallback = UPSTREAM_ERROR_MESSAGES.unknown): string {
  if (LEAK.test(message)) return fallback;
  return message;
}

/** Message shown for a connection test. Ignores any reason that is not a fixed category string. */
export function connectionTestMessage(result: {
  ok: boolean;
  reason?: string;
  category?: string;
}): string | undefined {
  const category = connectionTestCategory(result);
  return category ? UPSTREAM_ERROR_MESSAGES[category] : undefined;
}

/** Category shown for a failed connection test. Unknown when the adapter did not name a real category. */
export function connectionTestCategory(result: {
  ok: boolean;
  reason?: string;
  category?: string;
}): UpstreamErrorCategory | undefined {
  if (result.ok) return undefined;
  if (isUpstreamErrorCategory(result.category)) return result.category;
  if (result.reason && LEGACY_TEST_REASONS[result.reason]) return LEGACY_TEST_REASONS[result.reason];
  const fromReason = (Object.entries(UPSTREAM_ERROR_MESSAGES) as Array<[UpstreamErrorCategory, string]>).find(
    ([, message]) => message === result.reason,
  );
  return fromReason?.[0] ?? "unknown";
}

function fallbackFor(code: ErrorCode): string {
  switch (code) {
    case "INVALID_KEY":
      return UPSTREAM_ERROR_MESSAGES.invalid_key;
    case "RATE_LIMITED":
      return UPSTREAM_ERROR_MESSAGES.rate_limited;
    case "MODEL_UNAVAILABLE":
      return MODEL_UNAVAILABLE_MESSAGE;
    case "UPSTREAM_UNAVAILABLE":
      return UPSTREAM_ERROR_MESSAGES.unavailable;
    default:
      return UPSTREAM_ERROR_MESSAGES.unknown;
  }
}

/**
 * Visitor text for an error that may have been built from a provider response.
 * Upstream codes are forced onto the fixed category strings.
 */
export function messageForVisitor(error: AIConnectionsError): string {
  let message: string;
  switch (error.code) {
    case "INVALID_KEY":
      message = error.message === LOCAL_INVALID_KEY ? error.message : UPSTREAM_ERROR_MESSAGES.invalid_key;
      break;
    case "RATE_LIMITED":
      message = error.message === LOCAL_RATE_LIMIT ? error.message : UPSTREAM_ERROR_MESSAGES.rate_limited;
      break;
    case "MODEL_UNAVAILABLE":
      if (LOCAL_MODEL_MESSAGES.has(error.message)) message = error.message;
      else if (error.message.startsWith("Choose a provider and model for ")) message = error.message;
      else message = MODEL_UNAVAILABLE_MESSAGE;
      break;
    case "UPSTREAM_UNAVAILABLE":
      message =
        error.message === UPSTREAM_ERROR_MESSAGES.unknown
          ? error.message
          : UPSTREAM_ERROR_MESSAGES.unavailable;
      break;
    default:
      message = error.message;
      break;
  }
  return scrubVisitorText(message, fallbackFor(error.code));
}
