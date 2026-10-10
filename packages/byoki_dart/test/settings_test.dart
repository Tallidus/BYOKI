import 'dart:convert';

import 'package:byoki_dart/byoki_dart.dart';
import 'package:byoki_dart/src/secure_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  const key = 'sk-test-key-1234';

  testWidgets('tests, saves, picks a model, and removes the key without showing it again', (tester) async {
    final store = MemoryByokiKeyStore();
    final httpClient = ScriptedClient((request) async {
      return http.StreamedResponse(Stream.value(utf8.encode('{"data":[]}')), 200);
    });
    final client = ByokiClient(httpClient: httpClient);
    await tester.pumpWidget(_app(ByokiSettings(client: client, store: store)));
    await tester.pumpAndSettle();

    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Test and save')).onPressed, isNull);
    await tester.enterText(find.bySemanticsLabel('Provider API key'), 'nope');
    await tester.pump();
    expect(find.text('Unrecognized key'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Test and save')).onPressed, isNull);

    await tester.enterText(find.bySemanticsLabel('Provider API key'), key);
    await tester.pump();
    expect(find.text('OpenAI'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Test and save'));
    await tester.pumpAndSettle();

    expect(find.text('OpenAI key saved'), findsOneWidget);
    expect(find.text(key), findsNothing);
    expect(find.bySemanticsLabel('Provider API key'), findsNothing);
    expect(await store.readKey('openai'), key);
    expect(store.names, isNot(contains(key)));
    expect(store.names, contains('byoki.v1.key.openai'));
    expect(httpClient.requests.single.url.toString(), 'https://api.openai.com/v1/models');
    expect(httpClient.requests.single.url.toString(), isNot(contains(key)));
    expect(httpClient.requests.single.headers['authorization'], 'Bearer $key');
    expect(find.text('GPT-5.6 Terra'), findsOneWidget);

    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT-5.6 Luna').last);
    await tester.pumpAndSettle();
    expect(await store.readModel('openai', 'chat'), 'gpt-5.6-luna');

    await tester.tap(find.text('Remove key'));
    await tester.pumpAndSettle();
    expect(await store.readKey('openai'), isNull);
    expect(find.bySemanticsLabel('Provider API key'), findsOneWidget);
    expect(find.text(key), findsNothing);
    client.close();
  });

  testWidgets('a stored key is not copied back into the field', (tester) async {
    const secret = 'AIzaSyStoredKey99';
    final store = MemoryByokiKeyStore();
    await store.saveKey('gemini', secret);
    await store.saveModel('gemini', 'chat', 'gemini-3.1-flash-lite');
    await tester.pumpWidget(_app(ByokiSettings(client: ByokiClient(httpClient: ScriptedClient((_) async => fail('no network'))), store: store)));
    await tester.pumpAndSettle();
    expect(find.text('Gemini key saved'), findsOneWidget);
    expect(find.text('Gemini 3.1 Flash-Lite'), findsOneWidget);
    expect(find.text(secret), findsNothing);
    expect(find.byType(TextField), findsNothing);
  });

  test('secure storage names are the spec names, not the key', () async {
    final box = _MemoryBox();
    final store = SecureByokiKeyStore.box(box);
    const secret = 'sk-ant-api03-secret-value';
    await store.saveKey('anthropic', secret);
    await store.saveModel('anthropic', 'vision', 'claude-sonnet-5');
    expect(box.values.keys.toList(), ['byoki.v1.key.anthropic', 'byoki.v1.model.anthropic.vision']);
    expect(box.values.keys.join(' '), isNot(contains(secret)));
    expect(await store.readKey('anthropic'), secret);
    await store.deleteKey('anthropic');
    await store.deleteModels('anthropic');
    expect(box.values, isEmpty);
  });
}

Widget _app(Widget child) {
  return MaterialApp(home: Scaffold(body: child));
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

class _MemoryBox implements ByokiSecureBox {
  final values = <String, String>{};

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}
