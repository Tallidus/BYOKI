import 'dart:convert';

import 'package:byoki_dart/src/sse.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('joins a server-sent event that arrives in pieces', () async {
    final stream = Stream<List<int>>.fromIterable([
      utf8.encode('event: content_block_delta\ndata: {"text":'),
      utf8.encode('"Hi"}\n\ndata: [DONE]\n\n'),
    ]);
    final events = await parseSse(stream).toList();
    expect(events, hasLength(2));
    expect(events.first.event, 'content_block_delta');
    expect(events.first.data, '{"text":"Hi"}');
    expect(events.last.data, '[DONE]');
  });
}
