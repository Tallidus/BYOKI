import 'dart:convert';
import 'dart:io';

import 'package:byoki_dart/byoki_dart.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('matches the spec prefix order and does not treat sk-ant- as OpenAI', () {
    final spec = jsonDecode(File('../../spec/providers.json').readAsStringSync()) as Map<String, Object?>;
    final detection = (spec['keyDetection'] as List).cast<Map<String, Object?>>();
    expect(detection.map((item) => item['prefix']).toList(), ['sk-ant-', 'sk-', 'AIza']);
    expect(detectProvider('  sk-ant-api03-example  '), 'anthropic');
    expect(detectProvider('sk-proj-example'), 'openai');
    expect(detectProvider('sk-example'), 'openai');
    expect(detectProvider('AIzaSyExample'), 'gemini');
    expect(detectProvider('not-a-key'), isNull);
    expect(detectProvider('   '), isNull);
    for (final item in detection) {
      expect(detectProvider('${item['prefix']}example'), item['provider']);
    }
  });

  test('ships the same catalog as spec/catalog.json', () {
    final spec = jsonDecode(File('../../spec/catalog.json').readAsStringSync()) as Map<String, Object?>;
    expect(spec['updatedAt'], byokiCatalogUpdatedAt);
    final models = (spec['models'] as List).cast<Map<String, Object?>>();
    expect(byokiCatalog, hasLength(models.length));
    for (var i = 0; i < models.length; i++) {
      expect(byokiCatalog[i].id, models[i]['id']);
      expect(byokiCatalog[i].provider, models[i]['provider']);
      expect(byokiCatalog[i].displayName, models[i]['displayName']);
      expect(byokiCatalog[i].capabilities, models[i]['capabilities']);
    }
    final errors = jsonDecode(File('../../spec/errors.json').readAsStringSync()) as Map<String, Object?>;
    expect(errors['messages'], ByokiMessages.byCategory);
  });
}
