# BYOKI on-device specification

This document is the language-neutral contract for BYOKI. A client takes a key the user already owns and calls that provider's HTTPS API from the user's device. There is no BYOKI server. The key is not sent to the application author, to a proxy, or to any host other than the provider that issued it.

The TypeScript client (`createDirectClient`, `createOnDeviceClient`) and the Dart client (`package:byoki_dart`) implement this document. `spec/catalog.json`, `spec/providers.json`, and `spec/errors.json` are the data those clients must match. `spec/schemas/` describes the in-memory shapes.

An optional Node host still exists for applications that want server-side routing. It is not the primary model. See [INTEGRATING.md](../docs/INTEGRATING.md).

## Providers

| Id | Key prefix | Test | Invoke | Stream | Credential header |
| --- | --- | --- | --- | --- | --- |
| `openai` | `sk-` (including `sk-proj-`), after `sk-ant-` has been ruled out | `GET https://api.openai.com/v1/models` | `POST https://api.openai.com/v1/chat/completions` | Same URL, `stream: true` and `stream_options.include_usage: true` | `Authorization: Bearer <key>` |
| `anthropic` | `sk-ant-` | `GET https://api.anthropic.com/v1/models?limit=1` | `POST https://api.anthropic.com/v1/messages` | Same URL, `stream: true` | `x-api-key: <key>` |
| `gemini` | `AIza` | `GET https://generativelanguage.googleapis.com/v1beta/models` | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `POST .../models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key: <key>` |

The key is never placed in a URL, including the Gemini URL.

Anthropic requests also send `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true`. The second header is what makes a browser preflight succeed. Native clients send it too so one implementation covers both.

Detection trims whitespace, then applies prefixes in this order:

1. `sk-ant-` → `anthropic`
2. `sk-` → `openai`
3. `AIza` → `gemini`
4. anything else → unrecognized

An unrecognized or empty key produces category `invalid_key` and does not open a connection. The message must not contain the key.

## Request mapping

The caller passes messages with role `user`, `assistant`, or `system`. Each message has `text` or `parts`. A part is `{ type: "text", text }` or `{ type: "image", mimeType, data }`. Image `data` is raw base64, not a `data:` URL. Allowed types are `image/png`, `image/jpeg`, `image/webp`, and `image/gif`. At most 32 messages, and at most 8 parts on a message. The model id matches `^[A-Za-z0-9._:-]+$`. A caller-supplied provider that disagrees with prefix detection is `invalid_key` and is not sent.

Default timeouts are 15 seconds for a key test and 60 seconds for invoke.

OpenAI maps each message to `messages[].content`. Text parts stay `{ type: "text", text }`. Image parts become `{ type: "image_url", image_url: { url: "data:<mime>;base64,<data>" } }`. `maxOutputTokens` maps to `max_completion_tokens`.

Anthropic pulls system text into the top-level `system` string. Remaining messages use `user` or `assistant`. Image parts become `{ type: "image", source: { type: "base64", media_type, data } }`. `max_tokens` defaults to 1024 when the caller omits a limit.

Gemini puts system text in `systemInstruction`. `assistant` is sent as role `model`. Image parts become `{ inline_data: { mime_type, data } }`. `maxOutputTokens` maps to `generationConfig.maxOutputTokens`.

## Responses

A buffered call returns `outputText`, `provider`, `modelId`, and token `usage` when the provider sent counts. It does not return provider response metadata, request ids, or headers.

A stream yields zero or more `{ type: "delta", text }` events and then `{ type: "done", result }`. If the provider fails before the first delta, the call throws and yields nothing. If it fails after a delta, the call throws after those deltas. There is no `done` event on failure.

OpenAI reads `choices[0].message.content` or, while streaming, `choices[0].delta.content`, and stops on `data: [DONE]`. Usage comes from `prompt_tokens`, `completion_tokens`, and `prompt_tokens_details.cached_tokens`.

Anthropic joins `content[]` text blocks. While streaming it reads `content_block_delta` / `text_delta`, input tokens from `message_start`, and output tokens from `message_delta`.

Gemini joins candidate text parts. While streaming, each SSE object can contribute another piece of text. Usage comes from `usageMetadata.promptTokenCount` and `candidatesTokenCount`.

## Errors

Classify from the HTTP status and the provider's structured `error.code`, `error.type`, or `error.status` field. Do not copy the provider body, a masked key echo, a request id, or a header into the message the user sees.

| Condition | Category | Message |
| --- | --- | --- |
| HTTP 401 or 403, or `invalid_api_key`, `authentication_error`, `permission_error`, `permission_denied`, `unauthenticated`, `unauthorized` | `invalid_key` | The provider rejected this key. Check the key and try again. |
| `insufficient_quota`, `billing_hard_limit_reached`, `quota_exceeded`, `resource_exhausted`, or HTTP 402 | `quota` | The provider quota or billing limit was reached. Check the provider account. |
| HTTP 429, or `rate_limit_exceeded`, `rate_limit_error` | `rate_limited` | The provider rate limit was reached. Wait and try again. |
| HTTP 408 or 5xx, timeout, or `overloaded_error`, `api_error`, `server_error`, `unavailable`, `internal`, `deadline_exceeded`, `timeout` | `unavailable` | The provider is unavailable or the request timed out. Try again later. |
| Anything else | `unknown` | The provider request failed. Try again. |

Check invalid-key signals first, then quota, then rate limit. A 429 whose code is `insufficient_quota` is `quota`. The hosted Node API still uses HTTP 429 and error code `RATE_LIMITED` for both rate limits and quota; the `category` field distinguishes them.

A key test is the provider's model-list GET. It does not generate text. Success is any 2xx. Failure uses the table above.

## Model catalog

`spec/catalog.json` is the reviewed list. Every current row supports `chat` and `vision`. A listed model can still be disabled on a particular account. Clients may show the catalog without a network call. They must not invent prices.

## Storage

- Save a key only in platform secure storage: the OS keychain, Android EncryptedSharedPreferences, `flutter_secure_storage`, or an equivalent.
- Storage names are `byoki.v1.key.{provider}` and `byoki.v1.model.{provider}.{capability}`. Never use the API key as the storage key.
- Do not write the key to `localStorage`, `SharedPreferences`, logs, analytics, crash reports, URLs, or screenshots.
- Model ids are not secrets.
- After a successful test and save, clear the text field and do not show the key again.
- Removing a key deletes it from the device. It does not revoke the key at the provider.

A browser page has no OS keychain. Hold the key in memory for the session, or have the user enter it again. Do not put it in `localStorage`. Electron and other desktop shells should use the OS secret store (`safeStorage` in Electron). The renderer is still a browser, so provider CORS applies there. The Electron main process and Flutter (`dart:io`) are not subject to CORS.

## Browser CORS, probed 2026-10-10

These results used `Origin: https://example.com`. Providers can change them.

- OpenAI `OPTIONS` `POST /v1/chat/completions` returned 200. `access-control-allow-origin` echoed the origin. Allowed headers included `authorization` and `content-type`. Browser calls worked.
- Gemini `OPTIONS` `GET /v1beta/models` returned 200. `access-control-allow-origin` echoed the origin. Allowed headers included `x-goog-api-key`. Browser calls worked.
- Anthropic `OPTIONS` `POST /v1/messages` without the extra header returned 400 with body `Disallowed CORS origin` and no `access-control-allow-origin`. The browser blocked the call.
- Anthropic `OPTIONS` succeeded with `access-control-allow-origin: *` when `Access-Control-Request-Headers` included `anthropic-dangerous-direct-browser-access`. Sending that header on the real request is required in a browser.

Do not work around a CORS failure by posting the key to an application server.
