# Threat model

## Assets

- Provider API keys supplied by end users.
- Prompts and images the host sends to a provider.
- The usage ledger, which records metadata and must not record prompt or response content.

## Trust boundary

The host application authenticates the user and then holds that user's provider key. Anything running on that server can use the key outside this SDK. The SDK cannot cryptographically prevent host misuse. Users should also set spending and key controls in the provider account.

A declared capability restricts SDK routing and the settings UI. It does not restrict the provider account.

## What the SDK enforces

- Keys are submitted to the host API over the host session. The reference UI does not write them to browser storage.
- Read endpoints return connection status, not the key.
- Development storage encrypts keys with a master key supplied outside the data file.
- Logs pass through a redactor that strips common key prefixes and fields named like secrets.
- Records are scoped by tenant and user. One user cannot list, replace, or delete another user's key.
- Provider calls use fixed HTTPS endpoints. The first release does not accept a caller-supplied provider URL.
- Connection tests and model discovery are rate limited.
- Upstream error text is truncated and stripped of key-shaped strings before it is shown.

## What remains the host's job

- Authentication, CSRF secrets, TLS outside local development, and production secret storage.
- Deciding who may administer a tenant. Account sharing is not part of 0.1.
- Avoiding screenshots, traces, and analytics that include the key field.

Local deletion removes the key from this app. It does not revoke the key at the provider.
