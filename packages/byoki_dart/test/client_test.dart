import 'dart:convert';
import 'dart:io';

import 'package:byoki_dart/byoki_dart.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  const openAiKey = 'sk-test-key-1234';
  const anthropicKey = 'sk-ant-api03-test-key';
  const geminiKey = 'AIzaSyTestKey12';

  test('an unrecognized key does not open a connection and is not echoed', () async {
    final httpClient = ScriptedClient((request) async => jsonResponse(200, {}));
    final client = ByokiClient(httpClient: httpClient);
    final result = await client.testKey('not-a-provider-key');
    expect(httpClient.requests, isEmpty);
    expect(result.ok, isFalse);
    expect(result.category, 'invalid_key');
    expect(result.message, ByokiMessages.invalidKey);
    expect(result.message, isNot(contains('not-a-provider-key')));
    client.close();
  });

  test('key tests use the spec URL and put the key in the header only', () async {
    final spec = jsonDecode(File('../../spec/providers.json').readAsStringSync()) as Map<String, Object?>;
    final providers = (spec['providers'] as List).cast<Map<String, Object?>>();
    final keys = {'openai': openAiKey, 'anthropic': anthropicKey, 'gemini': geminiKey};
    for (final provider in providers) {
      final id = provider['id'] as String;
      final key = keys[id]!;
      final httpClient = ScriptedClient((request) async => jsonResponse(200, {'data': []}));
      final client = ByokiClient(httpClient: httpClient);
      final result = await client.testKey('  $key  ');
      expect(result.ok, isTrue);
      expect(result.provider, id);
      final request = httpClient.requests.single;
      final test = provider['test'] as Map<String, Object?>;
      expect(request.url.toString(), test['url']);
      expect(request.url.toString(), isNot(contains(key)));
      expect(request.headers[provider['authHeader']], _headerValue(provider, key));
      final extra = provider['extraHeaders'];
      if (extra is Map) {
        extra.forEach((name, value) {
          expect(request.headers['$name'], value);
        });
      }
      client.close();
    }
  });

  test('classifies quota separately from a rate limit and hides the provider body', () async {
    final secret = openAiKey;
    final cases = [
      (429, {'error': {'code': 'insufficient_quota', 'message': 'leak $secret'}}, 'quota', ByokiMessages.quota),
      (429, {'error': {'code': 'rate_limit_exceeded', 'message': 'leak $secret'}}, 'rate_limited', ByokiMessages.rateLimited),
      (401, {'error': {'code': 'invalid_api_key', 'message': 'leak $secret'}}, 'invalid_key', ByokiMessages.invalidKey),
      (503, {'error': {'message': 'leak $secret'}}, 'unavailable', ByokiMessages.unavailable),
    ];
    for (final item in cases) {
      final httpClient = ScriptedClient((request) async => jsonResponse(item.$1, item.$2));
      final client = ByokiClient(httpClient: httpClient);
      final result = await client.testKey(secret);
      expect(result.category, item.$3);
      expect(result.message, item.$4);
      expect(result.message, isNot(contains(secret)));
      expect('${result.message}', isNot(contains('leak')));
      client.close();
    }
  });

  test('sends image input and streams text for each provider', () async {
    final cases = [
      (
        openAiKey,
        'gpt-5.6-terra',
        'openai',
        'https://api.openai.com/v1/chat/completions',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        'image_url',
      ),
      (
        anthropicKey,
        'claude-sonnet-5',
        'anthropic',
        'https://api.anthropic.com/v1/messages',
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: message_delta\ndata: {"usage":{"output_tokens":1}}\n\n',
        'base64',
      ),
      (
        geminiKey,
        'gemini-3.5-flash',
        'gemini',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}\n\n',
        'inline_data',
      ),
    ];
    for (final item in cases) {
      final httpClient = ScriptedClient((request) async {
        return http.StreamedResponse(
          Stream<List<int>>.fromIterable([
            utf8.encode(item.$5.substring(0, 8)),
            utf8.encode(item.$5.substring(8)),
          ]),
          200,
          headers: {'content-type': 'text/event-stream'},
        );
      });
      final client = ByokiClient(httpClient: httpClient);
      final events = await client
          .invokeStream(
            apiKey: item.$1,
            modelId: item.$2,
            input: [
              ByokiMessage(
                role: 'user',
                parts: [
                  const ByokiPart.text('What is this?'),
                  const ByokiPart.image(mimeType: 'image/png', data: 'aGVsbG8='),
                ],
              ),
            ],
          )
          .toList();
      final request = httpClient.requests.single as http.Request;
      expect(request.url.toString(), item.$4);
      expect(request.url.toString(), isNot(contains(item.$1)));
      expect(request.body, contains(item.$6));
      expect(request.body, contains('aGVsbG8='));
      expect(request.body, isNot(contains('data:image/png;base64,data:')));
      expect(events.whereType<ByokiDelta>().map((event) => event.text).join(), 'Hi');
      final done = events.whereType<ByokiDone>().single;
      expect(done.result.outputText, 'Hi');
      expect(done.result.provider, item.$3);
      expect(done.result.usage?.outputTokens, 1);
      client.close();
    }
  });

  test('a failure after the first delta throws and keeps that delta', () async {
    const key = openAiKey;
    final httpClient = ScriptedClient((request) async {
      return http.StreamedResponse(
        Stream.value(
          utf8.encode(
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
            'data: {"error":{"message":"leak $key","code":"server_error"}}\n\n',
          ),
        ),
        200,
      );
    });
    final client = ByokiClient(httpClient: httpClient);
    final events = <ByokiEvent>[];
    await expectLater(
      () async {
        await for (final event in client.invokeStream(
          apiKey: key,
          modelId: 'gpt-5.6-terra',
          input: const [ByokiMessage(role: 'user', text: 'hello')],
        )) {
          events.add(event);
        }
      },
      throwsA(
        isA<ByokiException>()
            .having((error) => error.category, 'category', 'unavailable')
            .having((error) => error.message, 'message', ByokiMessages.unavailable)
            .having((error) => error.message, 'message', isNot(contains(key))),
      ),
    );
    expect(events, hasLength(1));
    expect((events.single as ByokiDelta).text, 'Hi');
    client.close();
  });

  test('rejects a data URL before any request', () async {
    final httpClient = ScriptedClient((request) async => jsonResponse(200, {}));
    final client = ByokiClient(httpClient: httpClient);
    await expectLater(
      client.invoke(
        apiKey: openAiKey,
        modelId: 'gpt-5.6-terra',
        input: const [
          ByokiMessage(
            role: 'user',
            parts: [ByokiPart.image(mimeType: 'image/png', data: 'data:image/png;base64,aaaa')],
          ),
        ],
      ),
      throwsA(isA<ByokiException>().having((error) => error.message, 'message', ByokiMessages.dataUrl)),
    );
    expect(httpClient.requests, isEmpty);
    client.close();
  });
}

String _headerValue(Map<String, Object?> provider, String key) {
  final scheme = provider['authScheme'];
  if (scheme is String) return '$scheme $key';
  return key;
}

class ScriptedClient extends http.BaseClient {
  ScriptedClient(this.onSend);

  final Future<http.StreamedResponse> Function(http.BaseRequest request) onSend;
  final requests = <http.BaseRequest>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    return onSend(request);
  }
}

http.StreamedResponse jsonResponse(int status, Object body) {
  final bytes = utf8.encode(jsonEncode(body));
  return http.StreamedResponse(Stream.value(bytes), status, headers: {'content-type': 'application/json'});
}
