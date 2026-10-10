# byoki_dart

On-device client for [BYOKI](https://github.com/Tallidus/BYOKI). The app collects a key the user already owns and calls OpenAI, Anthropic, or Gemini directly over HTTPS. There is no BYOKI server. The key is stored on the device and is not sent anywhere except that provider.

The language-neutral contract is [spec/SPEC.md](../../spec/SPEC.md).

## Install

Until this package is on pub.dev, depend on the Git repository:

```yaml
dependencies:
  byoki_dart:
    git:
      url: https://github.com/Tallidus/BYOKI.git
      path: packages/byoki_dart
      ref: cursor/http-invoke-contract-4083
```

After the change is on `main`, set `ref: main` or omit `ref`.

## Call a provider

```dart
import 'package:byoki_dart/byoki_dart.dart';

final client = ByokiClient();
final store = SecureByokiKeyStore();

final test = await client.testKey(apiKey);
if (!test.ok) {
  // test.message is a fixed sentence and does not echo the key.
  return;
}
await store.saveKey(test.provider!, apiKey);

final key = await store.readKey('openai');
await for (final event in client.invokeStream(
  apiKey: key!,
  modelId: 'gpt-5.6-terra',
  input: const [ByokiMessage(role: 'user', text: 'Hello')],
)) {
  switch (event) {
    case ByokiDelta(:final text):
      // append text
      break;
    case ByokiDone(:final result):
      // result.outputText, result.usage
      break;
  }
}
```

`testKey` checks the key with the provider's model list. `invoke` returns one result. `invokeStream` yields `ByokiDelta` values and then one `ByokiDone`. A failure before the first delta throws `ByokiException` and yields nothing. A failure after a delta throws after those deltas.

Image input is a part, not a data URL the caller assembles:

```dart
ByokiPart.image(mimeType: 'image/jpeg', data: base64Encode(bytes))
```

`detectProvider` reads the prefix: `sk-ant-` is Anthropic, other `sk-` keys (including `sk-proj-`) are OpenAI, and `AIza` is Gemini. Anything else is not sent.

`models()` returns the reviewed catalog. Pass a chosen id to `invoke` or `invokeStream`.

## Settings widget

```dart
ByokiSettings()
```

That builds a client and a `SecureByokiKeyStore`. The field is obscured. The widget detects the provider, enables **Test and save** once the prefix matches and the trimmed key is at least 8 characters, tests the key, stores it, clears the field, and offers a model picker. **Remove key** deletes the local copy. It does not revoke the key at the provider.

Pass `client` and `store` in tests. The default store uses `flutter_secure_storage` with names `byoki.v1.key.<provider>` and `byoki.v1.model.<provider>.<capability>`. The API key is never the storage name.

## Storage rules

Keep the key in platform secure storage only. Do not write it to logs, analytics, crash reports, URLs, screenshots, `SharedPreferences`, or `localStorage`. Model ids are not secrets. A browser page has no OS keychain; hold the key in memory for the session instead of writing it to web storage. Flutter mobile and desktop use the secure store above.

## Browser CORS

Flutter mobile and desktop (`dart:io`) are not subject to CORS. A Flutter web build is. As of 2026-10-10, OpenAI and Gemini answered browser preflights, and Anthropic allowed them only when the request included `anthropic-dangerous-direct-browser-access: true`. This client always sends that header. Do not proxy the key through a server to get around CORS. Details are in the spec.
