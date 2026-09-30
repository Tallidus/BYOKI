const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AIza[0-9A-Za-z\-_]{10,}/g,
];

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out.slice(0, 300);
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
