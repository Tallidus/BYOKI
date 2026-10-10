# Threat model

## Assets

- Provider API keys supplied by end users.
- Prompts and images the host sends to a provider.
- The usage ledger, which records metadata and must not record prompt or response content.

## On-device clients

The primary integration does not send the provider key to an application server. The key stays in platform secure storage on the device and is sent only to the provider HTTPS API that issued it. A web page should keep it in memory rather than `localStorage`. Deleting it on the device does not revoke it at the provider. The optional Node host below is a different trust boundary.

## Trust boundary

When an application uses the optional host, that host authenticates the user and then holds that user's provider key. Anything running on that server can use the key outside this SDK. The SDK cannot cryptographically prevent host misuse. Users should also set spending and key controls in the provider account.

A declared capability restricts SDK routing and the settings UI. It does not restrict the provider account.

## What the SDK enforces

- Keys are submitted to the host API over the host session. The reference UI does not write them to browser storage.
- Read endpoints return connection status, not the key.
- Development storage encrypts keys with a master key supplied outside the data file.
- Logs pass through a redactor that strips common key prefixes and fields named like secrets.
- Records are scoped by tenant and user. One user cannot list, replace, or delete another user's key.
- Provider calls use fixed HTTPS endpoints. The first release does not accept a caller-supplied provider URL.
- Connection tests and model discovery are rate limited.
- Upstream failures are shown as a fixed message for the failure category (rejected key, rate limit, quota or billing, unavailable or timeout, or an unknown error). Provider response text, masked key echoes, request ids, and headers are not returned.

## Public demo

The site at `examples/next-app` is a showcase, not a production identity system.

- Sessions are anonymous and per browser. There is no shared account.
- The default credential store is process memory with the session expiry. Ending the session deletes that visitor's keys.
- Mock mode is on unless `BYOKI_USE_MOCK=0`. In mock mode the adapter does not call a provider.
- Request handlers do not log prompt bodies, API keys, or upstream provider error text. A log line that does contain a key-shaped string, including a masked echo, is replaced entirely.
- `BYOKI_STORE=file` is a local option. It still encrypts keys, and logout deletes those credential rows, but it persists data on disk. Do not use it for the public site.

## Non-browser clients

Flutter, desktop, and other backends call the same routes. The host authenticates them with its own session. When that session is an `Authorization: Bearer` token, the host sets `AuthContext.transport` to `"bearer"` and does not apply cookie CSRF. The bearer token is not a provider key.

The client sends the provider key only to this host, in the `PUT` body, over HTTPS. After the host accepts it, the client should drop the key from memory and should not write it to ordinary preferences, logs, or crash reports. The host then sends the key only to the selected provider. Read APIs and the usage ledger do not return it. Local deletion still does not revoke the key at the provider.

## What remains the host's job

- Authentication, CSRF secrets, TLS outside local development, and production secret storage.
- Deciding who may administer a tenant. Account sharing is not part of 0.1.
- Avoiding screenshots, traces, and analytics that include the key field.

Local deletion removes the key from this app. It does not revoke the key at the provider.
