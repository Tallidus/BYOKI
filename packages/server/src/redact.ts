const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9*_-]{4,}/i,
  /sk-[A-Za-z0-9*_-]{4,}/i,
  /AIza[0-9A-Za-z*_-]{4,}/i,
];

/**
 * Drop a string that contains a key, including a provider's masked echo
 * (`sk-test-*******-000`). The whole value is replaced so the surrounding
 * upstream sentence is not kept.
 */
export function redact(text: string, extraSecrets: string[] = []): string {
  const tainted = extraSecrets.some((secret) => secret.length >= 4 && text.includes(secret)) || containsSecret(text);
  if (tainted) return "[redacted]";
  return text.slice(0, 300);
}

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export function createRedactingLogger(write: (line: string) => void): Logger {
  const emit = (level: string, event: string, fields?: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key === "authorization") {
        safe[key] = "[redacted]";
        continue;
      }
      safe[key] = typeof value === "string" ? redact(value) : value;
    }
    write(JSON.stringify({ level, event, ...safe }));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
