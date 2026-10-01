# API reference

The deployed docs render this reference from the package source: [https://byoki.eastonnielson.dev/docs#api](https://byoki.eastonnielson.dev/docs#api). Regenerate the JSON with `node scripts/generate-api-docs.mjs`.

Browser code should import `@byoki/core/browser`. Server code imports `@byoki/core`, `@byoki/server`, `@byoki/providers`, and `@byoki/pricing`.

## Host routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/ai/connections` | Allowed providers, connection status, purposes, links, and selections. No secrets. |
| PUT | `/api/ai/connections/:provider` | Create or replace a key for the signed-in user. Body: `{ "apiKey": "..." }`. |
| DELETE | `/api/ai/connections/:provider` | Delete the stored connection for this app. |
| POST | `/api/ai/connections/:provider/test` | Test a submitted or stored key. Rate limited. |
| GET | `/api/ai/models?capability=chat` | Allowed compatible models. Add `discover=1` to refresh from the provider. |
| PUT | `/api/ai/selections/:capability` | Save an allowed provider and model. Body: `{ "provider": "openai", "modelId": "..." }`. |
| GET | `/api/ai/usage?from=...&to=...` | Observed ledger summary for the signed-in user. |

The example also exposes `POST /api/ai/invoke` so the sample can send a chat or vision request. That route belongs to the host, not the settings client.

Mutating routes require the session cookie and an `x-csrf-token` header that matches the session. Error bodies use `{ ok: false, error: { code, message } }`.

Stable codes include `INVALID_CONFIG`, `PROVIDER_NOT_ALLOWED`, `CAPABILITY_UNSUPPORTED`, `MODEL_INCOMPATIBLE`, `MODEL_UNAVAILABLE`, `CREDENTIAL_MISSING`, `INVALID_KEY`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `BUDGET_BLOCKED`, `PAYLOAD_TOO_LARGE`, `UNAUTHENTICATED`, and `CSRF_FAILED`.

## Stores

`CredentialStore` is `put`, `get`, `delete`, and `has`, each scoped by `{ tenantId, userId }` and provider. `get` is for server-side calls only.

`createAIConnectionsApp` wires the router and the settings handlers. `createEncryptedFileStore` is the development implementation. It encrypts keys with AES-256-GCM and `BYOKI_MASTER_KEY`. A production host passes its own `credentials`, `selections`, and `ledger`. See `docs/deployment.md`.
