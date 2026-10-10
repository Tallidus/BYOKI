import 'dart:convert';

class SseEvent {
  const SseEvent(this.event, this.data);

  final String event;
  final String data;
}

/// Parse a `text/event-stream` body. Blocks may arrive split across chunks.
Stream<SseEvent> parseSse(Stream<List<int>> bytes) async* {
  var pending = '';
  await for (final chunk in bytes.transform(utf8.decoder)) {
    pending = (pending + chunk).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    while (true) {
      final split = pending.indexOf('\n\n');
      if (split < 0) break;
      final raw = pending.substring(0, split);
      pending = pending.substring(split + 2);
      final parsed = parseSseBlock(raw);
      if (parsed != null) yield parsed;
    }
  }
  if (pending.trim().isNotEmpty) {
    final parsed = parseSseBlock(pending);
    if (parsed != null) yield parsed;
  }
}

SseEvent? parseSseBlock(String raw) {
  var event = 'message';
  final data = <String>[];
  for (final line in raw.split('\n')) {
    if (line.isEmpty || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      final value = line.substring(5);
      data.add(value.startsWith(' ') ? value.substring(1) : value);
    }
  }
  if (data.isEmpty) return null;
  return SseEvent(event, data.join('\n'));
}
