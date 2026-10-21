export type ParamAttempt = {
  omit: Set<string>;
  tokenField: "max_completion_tokens" | "max_tokens";
};

export function initialAttempt(): ParamAttempt {
  return { omit: new Set(), tokenField: "max_completion_tokens" };
}

/**
 * Name of a parameter the provider rejected, or null when this is not a
 * parameter incompatibility. The provider message is not returned.
 */
export function unsupportedParameterName(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const param = typeof record.param === "string" ? record.param : "";
  const message = typeof record.message === "string" ? record.message : "";
  const unsupportedCode = code === "unsupported_parameter" || code === "unsupported_value";
  if (unsupportedCode && param.length > 0 && param.length <= 80) return param;
  const quoted = message.match(/unsupported parameter:\s*'([^']+)'/i);
  if (quoted?.[1] && quoted[1].length <= 80) return quoted[1];
  if (unsupportedCode && /temperature/i.test(message)) return "temperature";
  if (/max_completion_tokens/i.test(message) && /not supported|unsupported/i.test(message)) return "max_completion_tokens";
  if (
    /max_tokens/i.test(message) &&
    /not supported|unsupported/i.test(message) &&
    !/max_completion_tokens/i.test(message)
  ) {
    return "max_tokens";
  }
  if (status === "invalid_argument" || code === "invalid_argument") {
    if (/temperature/i.test(message) && /not supported|unknown|invalid/i.test(message)) return "temperature";
    if (/maxoutputtokens/i.test(message) && /not supported|unknown|invalid/i.test(message)) return "maxOutputTokens";
  }
  return null;
}

/** Next request shape after an unsupported-parameter error, or null when retrying will not help. */
export function nextAttempt(attempt: ParamAttempt, body: string): ParamAttempt | null {
  const raw = unsupportedParameterName(body);
  if (!raw) return null;
  const name = raw.split(".").pop() ?? raw;
  const omit = new Set(attempt.omit);
  let tokenField = attempt.tokenField;
  if (name === "max_completion_tokens" || name === "max_tokens") {
    const other = name === "max_completion_tokens" ? "max_tokens" : "max_completion_tokens";
    if (omit.has(name) && omit.has(other)) return null;
    omit.add(name);
    tokenField = omit.has(other) ? attempt.tokenField : other;
    if (omit.size === attempt.omit.size && tokenField === attempt.tokenField) return null;
    return { omit, tokenField };
  }
  if (name === "generationConfig") {
    if (omit.has("generationConfig")) return null;
    omit.add("generationConfig");
    omit.add("temperature");
    omit.add("maxOutputTokens");
    return { omit, tokenField };
  }
  if (omit.has(name)) return null;
  omit.add(name);
  return { omit, tokenField };
}
