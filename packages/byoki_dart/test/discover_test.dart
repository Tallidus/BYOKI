import 'dart:convert';

import 'package:byoki_dart/byoki_dart.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  test('categorizes provider models and falls back when listing fails', () async {
    expect(categorizeByokiModel('openai', 'text-embedding-3-small'), ['embedding']);
    expect(categorizeByokiModel('openai', 'whisper-1'), ['audio']);
    expect(categorizeByokiModel('openai', 'dall-e-3'), ['image']);
    expect(categorizeByokiModel('anthropic', 'claude-text-only', const ByokiListMetadata(imageInput: false)), isNot(contains('vision')));
    expect(
      categorizeByokiModel('gemini', 'gemini-3.5-flash', const ByokiListMetadata(methods: ['generateContent'])),
      containsAll(['chat', 'vision']),
    );

    var calls = 0;
    final httpClient = ScriptedClient((request) async {
      calls += 1;
      if (calls == 1) throw Exception('network');
      return jsonResponse(200, {
        'data': [
          {'id': 'gpt-5.6-terra'},
          {'id': 'text-embedding-3-small'},
        ],
      });
    });
    final client = ByokiClient(httpClient: httpClient);
    final fallback = await client.discoverModels('sk-test-key-1234');
    expect(fallback.fallback, isTrue);
    expect(fallback.models.map((model) => model.id), contains('gpt-5.6-terra'));
    final cached = await client.discoverModels('sk-test-key-1234');
    expect(calls, 1);
    expect(cached.fallback, isTrue);
    final refreshed = await client.discoverModels('sk-test-key-1234', refresh: true, capability: 'embedding');
    expect(refreshed.fallback, isFalse);
    expect(refreshed.models.map((model) => model.id), ['text-embedding-3-small']);
    expect(refreshed.models.single.displayName, 'text-embedding-3-small');
    client.close();
  });

  test('retries without an unsupported token parameter', () async {
    final bodies = <Map<String, Object?>>[];
    final httpClient = ScriptedClient((request) async {
      final body = jsonDecode(request is http.Request ? request.body : '') as Map<String, Object?>;
      bodies.add(body);
      if (body.containsKey('max_completion_tokens')) {
        return jsonResponse(400, {
          'error': {'code': 'unsupported_parameter', 'param': 'max_completion_tokens', 'message': 'Use max_tokens'},
        });
      }
      return jsonResponse(200, {
        'choices': [
          {'message': {'content': 'ok'}},
        ],
      });
    });
    final client = ByokiClient(httpClient: httpClient);
    final result = await client.invoke(
      apiKey: 'sk-test-key-1234',
      modelId: 'o1-custom',
      maxOutputTokens: 12,
      input: const [ByokiMessage(role: 'user', text: 'Hello')],
    );
    expect(result.outputText, 'ok');
    expect(bodies.first.containsKey('max_completion_tokens'), isTrue);
    expect(bodies.last['max_tokens'], 12);
    expect(bodies.last.containsKey('max_completion_tokens'), isFalse);
    client.close();
  });

  test('a model that cannot chat fails with the fixed sentence', () async {
    final httpClient = ScriptedClient((request) async {
      return jsonResponse(400, {
        'error': {'message': 'This is not a chat model. leak sk-test-key-1234'},
      });
    });
    final client = ByokiClient(httpClient: httpClient);
    expect(
      () => client.invoke(
        apiKey: 'sk-test-key-1234',
        modelId: 'whisper-1',
        input: const [ByokiMessage(role: 'user', text: 'Hello')],
      ),
      throwsA(
        isA<ByokiException>()
            .having((error) => error.message, 'message', ByokiMessages.taskUnsupported)
            .having((error) => error.message, 'hidden', isNot(contains('sk-test-key-1234'))),
      ),
    );
    client.close();
  });
}

http.StreamedResponse jsonResponse(int status, Object body) {
  return http.StreamedResponse(Stream.value(utf8.encode(jsonEncode(body))), status);
}

class ScriptedClient extends http.BaseClient {
  ScriptedClient(this.onSend);
  final Future<http.StreamedResponse> Function(http.BaseRequest request) onSend;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => onSend(request);
}
