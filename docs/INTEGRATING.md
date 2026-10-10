# Integrating BYOKI from any application

BYOKI is a Node 20 library. A browser, Flutter, desktop, or other backend cannot import the packages. Those clients talk to a small HTTP API that your application hosts. This document is the contract for that API. It is implemented by `handlers.dispatch` in `@byoki/server`, including `POST /api/ai/invoke`. A build that does not register that route cannot stream. The JavaScript call `router.forScope(scope).invoke(...)` still works and stays buffered. Token streaming is the HTTP API described here, and the same stream is available in-process as `router.forScope(scope).invokeStream(...)`.

There is no BYOKI-operated multi-tenant service. The published npm packages are libraries. You run the host.

## What you host

A Node 20 process that:

1. Authenticates the end user with your own session (BYOKI does not log people in).
2. Builds `{ tenantId, userId }` from that session. Never take those ids from the client as authorization.
3. Calls `createAIConnectionsApp` and forwards `/api/ai/*` to `handlers.dispatch`.
4. Stores provider keys in a `CredentialStore` you pass in. Development may use the encrypted file store (`BYOKI_MASTER_KEY`). Production uses a secrets manager or envelope encryption. See [deployment.md](deployment.md).

The host process is inside the trust boundary. It sees the user's provider key and the prompts it forwards. Anything on that server can use the key outside BYOKI. Say that to users, and point them at spending limits in the provider account. A capability limits routing and the settings screen. It does not limit the provider account.

Keys are sent to exactly two places:

- Your host, once, over HTTPS, in the JSON body of `PUT /api/ai/connections/:provider`.
- The provider the user selected (OpenAI, Anthropic, or Gemini), from the host, to that provider's fixed HTTPS API.

They are not sent to a BYOKI service. They are not written to logs. Read APIs do not return them. The usage ledger stores metadata only, not prompts, images, or keys.

### Minimal host

`createNodeHttpServer` turns Node's HTTP server into the Fetch handler and writes `text/event-stream` as chunks arrive. `authenticate` must set `transport: "bearer"` only after it has checked an `Authorization: Bearer` session token. That token is your session, not the provider API key. Do not set `bearer` for a cookie session: browsers attach cookies automatically, and skipping CSRF would allow a cross-site request.

```ts
import { defineAIConnections } from "@byoki/core";
import { PRICE_CATALOG, estimateCost } from "@byoki/pricing";
import { MANUAL_CATALOG, PROVIDER_LINKS, createProviderAdapters } from "@byoki/providers";
import { createAIConnectionsApp, createNodeHttpServer, type AuthContext } from "@byoki/server";

const ai = createAIConnectionsApp({
  config: defineAIConnections({
    appName: "Your app",
    capabilities: {
      chat: {
        description: "Answers questions for the signed-in user.",
        providers: ["openai", "anthropic", "gemini"],
        userCanChooseModel: true,
        required: true,
      },
      vision: {
        description: "Reads photos the user submits.",
        providers: ["openai", "anthropic", "gemini"],
        userCanChooseModel: true,
        required: false,
      },
    },
  }),
  adapters: createProviderAdapters(),
  catalog: MANUAL_CATALOG,
  links: PROVIDER_LINKS,
  estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
  credentials: yourCredentialStore,
  selections: yourSelectionStore,
  ledger: yourLedger,
});

function authenticate(request: Request): AuthContext {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const scope = lookupSession(token);
  return {
    scope,
    csrfHeader: null,
    expectedCsrf: null,
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    transport: "bearer",
  };
}

const server = createNodeHttpServer({
  authenticate,
  dispatch: (request, auth) => ai.handlers.dispatch(request, auth),
});
server.listen(8787, "127.0.0.1");

const sessions = new Map<string, { tenantId: string; userId: string }>();

function lookupSession(token: string): { tenantId: string; userId: string } | null {
  if (!token) return null;
  return sessions.get(token) ?? null;
}
```

`sessions` is a stand-in for your login system. Put a real store there. The snippet rejects every call until a token is inserted.

`lookupSession` is yours. Return `null` when the token is missing or unknown. The handler then responds `401` with `UNAUTHENTICATED`.

Cookie sessions (browsers) omit `transport` or set `"cookie"`, and send `x-csrf-token` equal to the token stored in the session. When both `Origin` and `Host` are present they must match. The React client in `@byoki/react` does this. It does not send prompts.

Serve the host with HTTPS outside local development. Put a proxy in front only if it does not buffer `text/event-stream`. The invoke stream sets `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`.

The repo's `kits/starter` server is a local fixed user on `127.0.0.1:8787`. It is a way to try the routes. It is not production auth.

In-process TypeScript hosts can keep calling `ai.router.forScope(scope).invoke(body)` for one buffered result. Call `invokeStream(body)` for the same events the HTTP stream emits. `invoke({ stream: true })` is still buffered; the `stream` flag on that call only marks the ledger row.

## HTTP contract

Base path: `/api/ai`. Every body below is JSON (`content-type: application/json`) unless the response is a stream.

Success envelope:

```json
{ "ok": true, "data": {} }
```

Error envelope:

```json
{ "ok": false, "error": { "code": "CREDENTIAL_MISSING", "message": "Connect openai before using chat." } }
```

`message` is safe to show. It does not contain provider response text, request ids, or the key.

### Auth

| Client | Request | Host `AuthContext` |
| --- | --- | --- |
| Browser | Session cookie and header `x-csrf-token` | `transport` omitted or `"cookie"`. `csrfHeader` is the header. `expectedCsrf` is the session token. |
| Native, desktop, another backend | `Authorization: Bearer <session>` | `transport: "bearer"` after you validate that token. No CSRF header. |

The bearer string is an application session. It is not an OpenAI, Anthropic, or Gemini key.

### Routes

| Method | Path | Body / query | Success `data` |
| --- | --- | --- | --- |
| GET | `/api/ai/connections` |  | App name, notices, capabilities, provider status, limits, observed spend. No key. |
| PUT | `/api/ai/connections/:provider` | `{ "apiKey": "<provider key>" }` | `{ "provider": "openai", "status": "connected" }` |
| DELETE | `/api/ai/connections/:provider` |  | `{ "provider", "status": "disconnected", "notice" }` |
| POST | `/api/ai/connections/:provider/test` | `{ "apiKey": "<optional>" }` | `{ "ok": true, "testMaySpendQuota": false }` or `{ "ok": false, "reason", "category", "testMaySpendQuota" }` |
| GET | `/api/ai/models?capability=chat` | Optional `discover=1` | `{ "models", "warnings", "caveat" }` |
| PUT | `/api/ai/selections/:capability` | `{ "provider": "openai", "modelId": "gpt-5.6-terra" }` | The saved selection |
| GET | `/api/ai/usage?from=<ISO>&to=<ISO>` | `from` and `to` optional | Ledger summary. No prompts. |
| POST | `/api/ai/invoke` | See below | JSON result, or `text/event-stream` |

`:provider` is `openai`, `anthropic`, or `gemini`. `:capability` is `chat` or `vision`.

`PUT` creates or replaces the key. The response status is `connected` and does not echo the key. `POST .../test` uses the body key when `apiKey` is a non-empty string, otherwise the stored key. A failed test returns HTTP 200 with `data.ok: false`. `reason` is one of the fixed sentences below. `category` is `invalid_key`, `rate_limited`, `unavailable`, or `unknown`.

`GET /models` without `discover=1` returns catalog models for providers this user has connected. Those ids are the ones `PUT /selections/:capability` will accept. `discover=1` may add extra rows from the provider, but a selection still has to be in the host catalog (`MANUAL_CATALOG` unless you pass a different `catalog`). Ignore discovered ids, or handle `MODEL_UNAVAILABLE`.

### Invoke body

```json
{
  "capability": "chat",
  "stream": true,
  "input": [
    { "role": "system", "text": "You help the signed-in user." },
    { "role": "user", "text": "What does this warning mean?" }
  ]
}
```

`stream` is optional. Omit it or set `false` for one JSON response. Set `true` for SSE.

A message has `role` (`user`, `assistant`, or `system`) and either `text` or `parts` (or both). Parts:

```json
{ "type": "text", "text": "What is in this photo?" }
```

```json
{ "type": "image", "mimeType": "image/jpeg", "data": "<raw base64, no data: prefix>" }
```

Image types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. At most 32 messages and 8 parts per message.

### Buffered invoke response

HTTP 200, `content-type: application/json`.

```json
{
  "ok": true,
  "data": {
    "outputText": "The light means low oil pressure.",
    "provider": "openai",
    "modelId": "gpt-5.6-terra",
    "providerRequestId": "chatcmpl-1",
    "usage": { "inputTokens": 20, "outputTokens": 8 },
    "estimationStatus": "known",
    "estimatedCost": 0.002,
    "warning": "Observed spend in this app reached the warning threshold."
  }
}
```

`providerRequestId`, `usage`, `estimatedCost`, and `warning` are omitted when the host does not have them. `estimationStatus` is `known` or `unknown`. Unknown cost is not zero. `usage` may include `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `imageCount`.

### Streaming invoke response

When `stream` is `true` and the call is accepted far enough to produce a token (or a final result with no tokens):

- HTTP 200
- `content-type: text/event-stream; charset=utf-8`
- Frames separated by a blank line

```text
event: delta
data: {"text":"The light "}

event: delta
data: {"text":"means low oil pressure."}

event: done
data: {"ok":true,"data":{"outputText":"The light means low oil pressure.","provider":"openai","modelId":"gpt-5.6-terra","estimationStatus":"unknown"}}
```

Zero or more `delta` events, then one `done` event on success. Concatenate `delta.text` for the live string. `done.data` is the same object as a buffered `data` payload. `done.data.outputText` is the final text.

If the provider fails after the first delta, the stream stays HTTP 200 and ends with:

```text
event: error
data: {"ok":false,"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The provider is unavailable or the request timed out. Try again later."}}
```

There is no `done` event after `error`.

If the failure happens before the first token (missing key, no model selected, bad JSON, budget block, provider rejection before any text), the response is the normal JSON error envelope and a non-200 status. It is not SSE. Check `content-type` before parsing.

### Errors

| HTTP | `error.code` | When |
| --- | --- | --- |
| 400 | `INVALID_CONFIG` | Bad JSON, unknown capability, bad message shape, `stream` not a boolean |
| 400 | `INVALID_KEY` | Key missing/too short on save, or the provider rejected the key |
| 400 | `CAPABILITY_UNSUPPORTED` | Adapter missing, or invoke not wired (only if you call `createHandlers` yourself and omit it) |
| 400 | `MODEL_INCOMPATIBLE` | Model does not support the capability |
| 401 | `UNAUTHENTICATED` | No session |
| 401 | `CSRF_FAILED` | Cookie transport, token mismatch, or `Origin` host is not `Host` |
| 403 | `PROVIDER_NOT_ALLOWED` | Provider is not in the capability allow list, or the path provider is unknown |
| 404 | `CREDENTIAL_MISSING` | No stored key for the selected provider |
| 404 | `MODEL_UNAVAILABLE` | No selection saved, or the model is not in the host catalog |
| 413 | `PAYLOAD_TOO_LARGE` | Key routes: body over 8192 bytes. Invoke and the Node listener: body over 1048576 bytes |
| 429 | `RATE_LIMITED` | Connection test or model discovery over the host limit (default 20 per 60 seconds per user and provider). Also used when the provider itself rate-limits a call |
| 429 | `BUDGET_BLOCKED` | Observed in-app spend is at `limits.budget.blockAtUsd` before the call. This is not a guaranteed cap |
| 502 | `UPSTREAM_UNAVAILABLE` | Provider timeout, 5xx, or an unclassified provider failure |

Fixed provider sentences:

| Category | Message |
| --- | --- |
| `invalid_key` | The provider rejected this key. Check the key and try again. |
| `rate_limited` | The provider rate limit or quota was reached. Wait and try again. |
| `unavailable` | The provider is unavailable or the request timed out. Try again later. |
| `unknown` | The provider request failed. Try again. |

### Providers and catalog models

The host allow list decides which of these a capability may use. This is the default `MANUAL_CATALOG` shipped with `@byoki/providers`. Every row supports `chat` and `vision`.

| Provider | Model id | Display name | Key header the host sends | Account pages |
| --- | --- | --- | --- | --- |
| `openai` | `gpt-5.6-terra` | GPT-5.6 Terra | `Authorization: Bearer` | https://platform.openai.com/api-keys |
| `openai` | `gpt-5.6-luna` | GPT-5.6 Luna | `Authorization: Bearer` | usage https://platform.openai.com/usage |
| `anthropic` | `claude-sonnet-5` | Claude Sonnet 5 | `x-api-key` | https://platform.claude.com/settings/keys |
| `anthropic` | `claude-haiku-4-5` | Claude Haiku 4.5 | `x-api-key` | usage https://platform.claude.com/usage |
| `gemini` | `gemini-3.5-flash` | Gemini 3.5 Flash | `x-goog-api-key` | https://aistudio.google.com/apikey |
| `gemini` | `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite | `x-goog-api-key` | usage https://aistudio.google.com/usage |

The client never sets those provider headers and never chooses the provider URL. A listed model can still be disabled on a given account. The host returns `MODEL_UNAVAILABLE` and does not switch models on its own.

`GET /connections` includes `keyUrl`, `usageUrl`, and `billingUrl` for the current links, plus `testMaySpendQuota`. For these three adapters that flag is `false` (the test lists models and does not generate text). Still tell the user a test can fail or, if you register a different adapter, spend quota.

### Client storage

- Send the provider key only to your host, in the `PUT` body, over HTTPS.
- Use an obscured input. After HTTP 200, clear the field.
- Do not put the key in a URL, analytics event, crash report, screenshot, or ordinary preferences.
- Do not keep the key on the device after the host accepts it. If a draft has to survive the process being killed, use the platform secret store and delete it when the host reports `connected`.
- Store the session bearer in the platform secret store. It is a different secret from the provider key.
- Deleting a connection deletes the key from this app. It does not revoke it at the provider.

## Dart / Flutter

An app such as a vehicle log (maintenance, fuel, inspections, photos) hosts the Node process above and ships a Flutter client. The client does not depend on a Dart BYOKI package. It uses `package:http`.

Declare `chat` and `vision` in the host config if the product both answers questions and reads photos. That declaration lives in the Node host, not in a BYOKI change.

Suggested `pubspec.yaml` dependencies:

```yaml
dependencies:
  http: ^1.2.0
  flutter_secure_storage: ^9.2.0
```

`flutter_secure_storage` holds the session bearer. It should not hold the provider key after a successful save.

```dart
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class ByokiException implements Exception {
  ByokiException(this.statusCode, this.code, this.message);
  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => '$code ($statusCode): $message';
}

class ByokiDelta {
  ByokiDelta(this.text);
  final String text;
}

class ByokiDone {
  ByokiDone(this.data);
  final Map<String, dynamic> data;
  String get outputText => data['outputText'] as String? ?? '';
}

/// `baseUri` is the origin plus `/api/ai`, with no trailing slash.
/// Example: `Uri.parse('https://api.example.com/api/ai')`.
class ByokiClient {
  ByokiClient({required this.baseUri, required this.sessionToken, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final Uri baseUri;
  final String sessionToken;
  final http.Client _http;

  Map<String, String> _headers({bool json = true}) => {
        'authorization': 'Bearer $sessionToken',
        if (json) 'content-type': 'application/json',
        'accept': 'application/json',
      };

  Uri _url(String path, [Map<String, String>? query]) {
    final suffix = path.startsWith('/') ? path : '/$path';
    return baseUri.replace(path: '${baseUri.path}$suffix', queryParameters: query);
  }

  Future<Map<String, dynamic>> connections() => _data(await _send('GET', '/connections'));

  Future<void> putKey(String provider, String apiKey) async {
    await _data(await _send('PUT', '/connections/$provider', {'apiKey': apiKey}));
  }

  Future<void> deleteKey(String provider) async {
    await _data(await _send('DELETE', '/connections/$provider'));
  }

  Future<Map<String, dynamic>> testKey(String provider, {String? apiKey}) =>
      _data(await _send('POST', '/connections/$provider/test', {if (apiKey != null) 'apiKey': apiKey}));

  Future<List<Map<String, dynamic>>> models(String capability) async {
    final data = await _data(await _send('GET', '/models', null, {'capability': capability}));
    return (data['models'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<void> selectModel(String capability, String provider, String modelId) async {
    await _data(await _send('PUT', '/selections/$capability', {'provider': provider, 'modelId': modelId}));
  }

  Future<Map<String, dynamic>> invoke({
    required String capability,
    required List<Map<String, dynamic>> input,
  }) =>
      _data(await _send('POST', '/invoke', {'capability': capability, 'input': input, 'stream': false}));

  /// Yields [ByokiDelta] values, then one [ByokiDone].
  /// A failure before the first token throws [ByokiException] and yields nothing.
  /// A failure after a delta throws after the deltas already emitted.
  Stream<Object> invokeStream({
    required String capability,
    required List<Map<String, dynamic>> input,
  }) async* {
    final request = http.Request('POST', _url('/invoke'))
      ..headers.addAll(_headers())
      ..body = jsonEncode({'capability': capability, 'input': input, 'stream': true});
    final response = await _http.send(request);
    final type = response.headers['content-type'] ?? '';
    if (!type.contains('text/event-stream')) {
      final raw = await response.stream.bytesToString();
      throw _error(response.statusCode, raw);
    }
    var buffer = '';
    await for (final chunk in response.stream.transform(utf8.decoder)) {
      buffer += chunk;
      while (buffer.contains('\n\n')) {
        final split = buffer.indexOf('\n\n');
        final frame = buffer.substring(0, split);
        buffer = buffer.substring(split + 2);
        final event = _frame(frame);
        if (event == null) continue;
        if (event.$1 == 'delta') {
          yield ByokiDelta((event.$2['text'] as String?) ?? '');
        } else if (event.$1 == 'done') {
          final data = event.$2['data'];
          if (data is Map<String, dynamic>) yield ByokiDone(data);
        } else if (event.$1 == 'error') {
          final error = event.$2['error'];
          final code = error is Map ? '${error['code']}' : 'UPSTREAM_UNAVAILABLE';
          final message = error is Map ? '${error['message']}' : 'The provider request failed. Try again.';
          throw ByokiException(200, code, message);
        }
      }
    }
  }

  Future<http.Response> _send(String method, String path, [Object? body, Map<String, String>? query]) {
    final uri = _url(path, query);
    final headers = _headers(json: body != null || method != 'GET');
    switch (method) {
      case 'GET':
        return _http.get(uri, headers: headers);
      case 'PUT':
        return _http.put(uri, headers: headers, body: jsonEncode(body ?? {}));
      case 'POST':
        return _http.post(uri, headers: headers, body: jsonEncode(body ?? {}));
      case 'DELETE':
        return _http.delete(uri, headers: headers);
      default:
        throw ArgumentError(method);
    }
  }

  Future<Map<String, dynamic>> _data(http.Response response) async {
    final json = _decode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300 || json['ok'] != true) {
      throw _fromJson(response.statusCode, json);
    }
    final data = json['data'];
    if (data is Map<String, dynamic>) return data;
    return {};
  }

  ByokiException _error(int status, String raw) => _fromJson(status, _decode(raw));

  Map<String, dynamic> _decode(String raw) {
    try {
      final value = jsonDecode(raw);
      if (value is Map<String, dynamic>) return value;
    } catch (_) {}
    return {
      'ok': false,
      'error': {'code': 'UPSTREAM_UNAVAILABLE', 'message': 'The provider request failed. Try again.'},
    };
  }

  ByokiException _fromJson(int status, Map<String, dynamic> json) {
    final error = json['error'];
    final code = error is Map ? '${error['code']}' : 'UPSTREAM_UNAVAILABLE';
    final message = error is Map ? '${error['message']}' : 'The provider request failed. Try again.';
    return ByokiException(status, code, message);
  }

  (String, Map<String, dynamic>)? _frame(String raw) {
    var name = 'message';
    final data = <String>[];
    for (final line in raw.split('\n')) {
      if (line.startsWith('event:')) name = line.substring(6).trim();
      if (line.startsWith('data:')) data.add(line.substring(5).trimLeft());
    }
    if (data.isEmpty) return null;
    try {
      final decoded = jsonDecode(data.join('\n'));
      if (decoded is Map<String, dynamic>) return (name, decoded);
    } on FormatException {
      throw ByokiException(200, 'UPSTREAM_UNAVAILABLE', 'The provider request failed. Try again.');
    }
    return null;
  }

  void close() => _http.close();
}
```

Screen flow for the signed-in user:

1. Read the session bearer from secure storage. If there is no session, your app signs the user in. That login is not a provider key.
2. `connections()` shows which providers are `connected` and the `keyUrl` to open so the user can create a key at the provider.
3. A password-style field takes the provider key. Call `testKey` with the draft, then `putKey` on success. Clear the controller in a `finally` or immediately after `putKey` returns. Do not `debugPrint` the controller value.
4. `models('chat')` fills a model picker. `selectModel('chat', provider, modelId)` saves it. Repeat for `vision` if you declared it.
5. Send a prompt with `invokeStream`. Append each `ByokiDelta.text` to the on-screen answer. Stop on `ByokiDone`. On `ByokiException`, show `message` and, for `MODEL_UNAVAILABLE` or `CREDENTIAL_MISSING`, send the user back to the picker or the key field.

A photo uses a part, not a data URL:

```dart
final bytes = await file.readAsBytes();
await for (final event in client.invokeStream(
  capability: 'vision',
  input: [
    {
      'role': 'user',
      'parts': [
        {'type': 'text', 'text': 'What is in this photo?'},
        {'type': 'image', 'mimeType': 'image/jpeg', 'data': base64Encode(bytes)},
      ],
    },
  ],
)) {
  // ByokiDelta or ByokiDone
}
```

Keep the image bytes out of logs as well. The host forwards them to the selected provider and does not store them in the ledger.

## Web, desktop, and other backends

The same routes and JSON shapes apply.

- A React web app can keep `@byoki/react` for the settings screen and call `POST /api/ai/invoke` from the host for prompts. See [integration.md](integration.md).
- A desktop app uses the bearer flow above. Store the session in the OS keychain. Do not store the provider key after save.
- Another backend that already has the user session calls `handlers.dispatch` in-process, or calls the HTTP API with a bearer token it issued. It still must not log the key or the prompt.
