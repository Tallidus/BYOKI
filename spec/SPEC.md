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

OpenAI maps each message to `messages[].content`. Text parts stay `{ type: "text", text }`. Image parts become `{ type: "image_url", image_url: { url: "data:<mime>;base64,<data>" } }`. `maxOutputTokens` maps to `max_completion_tokens`. An optional `temperature` is sent only when the caller set one.

Anthropic pulls system text into the top-level `system` string. Remaining messages use `user` or `assistant`. Image parts become `{ type: "image", source: { type: "base64", media_type, data } }`. `max_tokens` defaults to 1024 when the caller omits a limit. An optional `temperature` is sent only when the caller set one.

Gemini puts system text in `systemInstruction`. `assistant` is sent as role `model`. Image parts become `{ inline_data: { mime_type, data } }`. `maxOutputTokens` maps to `generationConfig.maxOutputTokens`. An optional `temperature` is sent on `generationConfig` only when the caller set one.

If the provider rejects a parameter as unsupported (`unsupported_parameter`, `unsupported_value`, or an equivalent invalid-argument name such as `temperature`, `max_tokens`, `max_completion_tokens`, or `maxOutputTokens`), the client retries that call once without the parameter. `max_completion_tokens` and `max_tokens` are swapped for each other before either is dropped. The retry does not copy the provider message. At most three attempts are made. A failure after that uses the error table below.

`invoke` and `invokeStream` perform chat and vision text generation. A call whose capability is `image`, `embedding`, or `audio`, or whose known model does not include the requested capability, fails before the provider is called. The message is `This model can't do that task. Choose a model that supports it.` The same sentence is used when the provider says the model cannot do the task. The provider body is not shown.

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

`spec/catalog.json` is the developer's reviewed list. Every current row supports `chat` and `vision`. A listed model can still be disabled on a particular account. Clients may show the catalog without a network call. They must not invent prices.

An app may also declare `recommendedModels` for each capability it uses, and a `defaultModel`. The default is the first recommended model when the app does not set one. The default has to be one of the recommended models. Recommended providers have to be in that capability's provider list.

## Model discovery

With the user's key, the client lists models from the provider and does not send the key anywhere else:

| Provider | List |
| --- | --- |
| `openai` | `GET https://api.openai.com/v1/models` |
| `anthropic` | `GET https://api.anthropic.com/v1/models` (page with `limit` and `after_id`, at most 10 pages) |
| `gemini` | `GET https://generativelanguage.googleapis.com/v1beta/models` (page with `pageSize` and `pageToken`, at most 10 pages) |

The list is cached for the life of the client instance, keyed by provider and a fingerprint of the key. The raw key is not stored in the cache. A caller may force a refresh. If the list fails because of CORS, the network, or permissions, the client returns the developer catalog for that provider and marks the result as a fallback. It does not throw, and it does not post the key to an application server.

Each returned model is tagged with one or more of `chat`, `vision`, `image`, `embedding`, and `audio`. Apps filter to the capabilities they use. Dungeon Assistant, for example, can ask for `chat` for stat blocks and `image` for artwork. Provider metadata is used when the list includes it. Otherwise the id is classified by name:

| Signal | Capability |
| --- | --- |
| Anthropic `capabilities.image_input.supported: true` | `vision`. An explicit `false` does not add `vision`. |
| Gemini `supportedGenerationMethods` containing `generateContent` | `chat`. Gemini chat models also get `vision` unless image input was explicitly disabled. |
| Gemini method containing `embed` | `embedding` |
| Gemini method containing `bidiGenerate` | `audio` |
| Id contains `embed` | `embedding` |
| Id matches `whisper`, `transcribe`, or `tts-1` / `tts-` | `audio` only |
| Id contains `audio`, `speech`, `realtime`, or ends in `-tts` | `audio`, and `chat` when the id is also a chat family |
| Id matches `dall-e`, `dalle`, `gpt-image`, `imagen`, `flash-image`, `image-preview`, or `-image` | `image`. Gemini image models that also support `generateContent` keep `chat`. |
| OpenAI id matching `gpt-` (except `gpt-image`), `o` plus a digit, or `chatgpt-` | `chat`. `gpt-4o`, `gpt-4.1`, `gpt-4-turbo`, `gpt-5`, `o3` and later, and `chatgpt-4o` also get `vision`. |
| Anthropic id starting with `claude` | `chat`, and `vision` when image input was not explicitly disabled |
| Anything else | no capability tag. It can still be chosen with a custom model id. |

A model id has to match `^[A-Za-z0-9._:-]+$`. Ids that do not match are dropped from the list.

When the same id is in the developer catalog, the catalog display name is kept and the capability tags are the union of both lists.

## Choosing a model

Settings show recommended models first, under the label `Recommended`. The other models for that capability are under `All available models`. A custom model id field accepts an id the list did not return.

Selecting a model that is not in the app's recommended list, including a custom id, shows this warning and does not save until the user acknowledges it:

> This model isn't recommended for this app. It may produce unexpected results, and you're responsible for its output.

The acknowledgment is stored per model at `byoki.v1.ack.{provider}.{modelId}`. It is not a secret. A later selection of that same model does not ask again. The selected model id is stored at `byoki.v1.model.{provider}.{capability}`. Both stay on the device. If the app declared no recommended models, choosing a listed model does not warn. A custom id still warns.

`invoke` uses the model id the user selected.

## Storage

- Save a key only in platform secure storage: the OS keychain, Android EncryptedSharedPreferences, `flutter_secure_storage`, or an equivalent.
- Storage names are `byoki.v1.key.{provider}`, `byoki.v1.model.{provider}.{capability}`, and `byoki.v1.ack.{provider}.{modelId}`. Never use the API key as the storage key.
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
