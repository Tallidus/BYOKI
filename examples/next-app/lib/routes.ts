export const HOST_ROUTES = [
  {
    method: "GET",
    path: "/api/ai/connections",
    purpose: "Allowed providers, connection status, purposes, links, and selections. No secrets.",
  },
  {
    method: "PUT",
    path: "/api/ai/connections/:provider",
    purpose: "Create or replace a key for the signed-in user. Body: { apiKey }.",
  },
  {
    method: "DELETE",
    path: "/api/ai/connections/:provider",
    purpose: "Delete the stored connection for this app.",
  },
  {
    method: "POST",
    path: "/api/ai/connections/:provider/test",
    purpose: "Test a submitted or stored key. Rate limited.",
  },
  {
    method: "GET",
    path: "/api/ai/models?capability=chat",
    purpose: "Allowed compatible models. Add discover=1 to refresh from the provider.",
  },
  {
    method: "PUT",
    path: "/api/ai/selections/:capability",
    purpose: "Save an allowed provider and model. Body: { provider, modelId }.",
  },
  {
    method: "GET",
    path: "/api/ai/usage?from=...&to=...",
    purpose: "Observed ledger summary for the signed-in user.",
  },
] as const;

export const ERROR_CODES = [
  "INVALID_CONFIG",
  "PROVIDER_NOT_ALLOWED",
  "CAPABILITY_UNSUPPORTED",
  "MODEL_INCOMPATIBLE",
  "MODEL_UNAVAILABLE",
  "CREDENTIAL_MISSING",
  "INVALID_KEY",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "BUDGET_BLOCKED",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_FAILED",
] as const;
