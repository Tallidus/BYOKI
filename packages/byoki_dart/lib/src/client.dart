import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'catalog.dart';
import 'detect.dart';
import 'errors.dart';
import 'sse.dart';

const _imageMime = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'};
final _modelId = RegExp(r'^[A-Za-z0-9._:-]+$');

class ByokiPart {
  const ByokiPart.text(this.text) : type = 'text', mimeType = null, data = null;

  const ByokiPart.image({required this.mimeType, required this.data}) : type = 'image', text = null;

  final String type;
  final String? text;
  final String? mimeType;
  final String? data;
}

class ByokiMessage {
  const ByokiMessage({required this.role, this.text, this.parts});

  final String role;
  final String? text;
  final List<ByokiPart>? parts;
}

class ByokiUsage {
  const ByokiUsage({this.inputTokens, this.outputTokens, this.cacheReadTokens, this.cacheWriteTokens});

  final int? inputTokens;
  final int? outputTokens;
  final int? cacheReadTokens;
  final int? cacheWriteTokens;
}

class ByokiResult {
  const ByokiResult({required this.outputText, required this.provider, required this.modelId, this.usage});

  final String outputText;
  final String provider;
  final String modelId;
  final ByokiUsage? usage;
}

class ByokiKeyTest {
  const ByokiKeyTest({required this.ok, this.provider, this.category, this.message});

  final bool ok;
  final String? provider;
  final String? category;
  final String? message;
}

sealed class ByokiEvent {}

class ByokiDelta extends ByokiEvent {
  ByokiDelta(this.text);
  final String text;
}

class ByokiDone extends ByokiEvent {
  ByokiDone(this.result);
  final ByokiResult result;
}

/// Calls OpenAI, Anthropic, or Gemini directly. The key is not stored here.
class ByokiClient {
  ByokiClient({http.Client? httpClient})
    : _http = httpClient ?? http.Client(),
      _ownsHttp = httpClient == null;

  final http.Client _http;
  final bool _ownsHttp;

  static const testTimeout = Duration(seconds: 15);
  static const invokeTimeout = Duration(seconds: 60);

  String? detect(String apiKey) => detectProvider(apiKey);

  List<ByokiModel> models({String? provider, String? capability}) {
    return byokiCatalog.where((model) {
      if (provider != null && model.provider != provider) return false;
      if (capability != null && !model.capabilities.contains(capability)) return false;
      return true;
    }).toList();
  }

  Future<ByokiKeyTest> testKey(String apiKey) async {
    final key = apiKey.trim();
    final provider = detectProvider(key);
    if (key.isEmpty) {
      return const ByokiKeyTest(ok: false, category: 'invalid_key', message: ByokiMessages.emptyKey);
    }
    if (provider == null) {
      return const ByokiKeyTest(ok: false, category: 'invalid_key', message: ByokiMessages.invalidKey);
    }
    try {
      final request = http.Request('GET', _testUri(provider));
      request.headers.addAll(_auth(provider, key));
      final response = await _send(request, testTimeout);
      await response.stream.drain<void>();
      return ByokiKeyTest(ok: true, provider: provider);
    } on ByokiException catch (error) {
      return ByokiKeyTest(ok: false, provider: provider, category: error.category, message: error.message);
    }
  }

  Future<ByokiResult> invoke({
    required String apiKey,
    required String modelId,
    required List<ByokiMessage> input,
    String? provider,
    String capability = 'chat',
    int? maxOutputTokens,
    Duration? timeout,
  }) async {
    final prepared = _prepare(
      apiKey: apiKey,
      modelId: modelId,
      input: input,
      provider: provider,
      capability: capability,
      maxOutputTokens: maxOutputTokens,
      timeout: timeout,
    );
    final request = _jsonRequest(prepared, stream: false);
    final response = await _send(request, prepared.timeout);
    final record = _object(await response.stream.bytesToString());
    _throwIfError(record);
    return ByokiResult(
      outputText: _bufferedText(prepared.provider, record),
      provider: prepared.provider,
      modelId: prepared.modelId,
      usage: _bufferedUsage(prepared.provider, record),
    );
  }

  Stream<ByokiEvent> invokeStream({
    required String apiKey,
    required String modelId,
    required List<ByokiMessage> input,
    String? provider,
    String capability = 'chat',
    int? maxOutputTokens,
    Duration? timeout,
  }) async* {
    final prepared = _prepare(
      apiKey: apiKey,
      modelId: modelId,
      input: input,
      provider: provider,
      capability: capability,
      maxOutputTokens: maxOutputTokens,
      timeout: timeout,
    );
    final request = _jsonRequest(prepared, stream: true);
    final response = await _send(request, prepared.timeout);
    final accum = _Accum();
    try {
      await for (final event in parseSse(response.stream.timeout(prepared.timeout))) {
        if (event.data == '[DONE]') break;
        final record = _object(event.data);
        _throwIfError(record);
        final piece = _deltaText(prepared.provider, event, record);
        _readStreamUsage(prepared.provider, event, record, accum);
        if (piece.isNotEmpty) {
          accum.text += piece;
          yield ByokiDelta(piece);
        }
      }
    } on ByokiException {
      rethrow;
    } on TimeoutException {
      throw networkFailure();
    } catch (_) {
      throw networkFailure();
    }
    yield ByokiDone(
      ByokiResult(outputText: accum.text, provider: prepared.provider, modelId: prepared.modelId, usage: accum.usage),
    );
  }

  void close() {
    if (_ownsHttp) _http.close();
  }

  http.Request _jsonRequest(_Prepared prepared, {required bool stream}) {
    final request = http.Request('POST', _invokeUri(prepared.provider, prepared.modelId, stream: stream));
    request.headers.addAll({..._auth(prepared.provider, prepared.key), 'content-type': 'application/json'});
    request.body = jsonEncode(_body(prepared, stream: stream));
    return request;
  }

  Future<http.StreamedResponse> _send(http.Request request, Duration timeout) async {
    try {
      final response = await _http.send(request).timeout(timeout);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final raw = await response.stream.bytesToString().timeout(timeout);
        throw classifyProviderFailure(response.statusCode, raw);
      }
      return response;
    } on ByokiException {
      rethrow;
    } on TimeoutException {
      throw networkFailure();
    } catch (_) {
      throw networkFailure();
    }
  }
}

class _Prepared {
  _Prepared({
    required this.key,
    required this.provider,
    required this.modelId,
    required this.messages,
    required this.timeout,
    this.maxOutputTokens,
  });

  final String key;
  final String provider;
  final String modelId;
  final List<_WireMessage> messages;
  final Duration timeout;
  final int? maxOutputTokens;
}

class _WireMessage {
  _WireMessage(this.role, this.parts);
  final String role;
  final List<ByokiPart> parts;
}

class _Accum {
  String text = '';
  int? inputTokens;
  int? outputTokens;
  int? cacheRead;
  int? cacheWrite;

  ByokiUsage? get usage {
    if (inputTokens == null && outputTokens == null && cacheRead == null && cacheWrite == null) return null;
    return ByokiUsage(
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    );
  }
}

_Prepared _prepare({
  required String apiKey,
  required String modelId,
  required List<ByokiMessage> input,
  String? provider,
  String capability = 'chat',
  int? maxOutputTokens,
  Duration? timeout,
}) {
  final key = apiKey.trim();
  final detected = detectProvider(key);
  if (key.isEmpty) {
    throw ByokiException(category: 'invalid_key', message: ByokiMessages.emptyKey, code: 'INVALID_KEY');
  }
  if (detected == null || (provider != null && provider != detected)) {
    throw ByokiException(category: 'invalid_key', message: ByokiMessages.invalidKey, code: 'INVALID_KEY');
  }
  final model = modelId.trim();
  if (model.isEmpty || !_modelId.hasMatch(model) || model.contains(key)) {
    throw ByokiException(category: 'unknown', message: ByokiMessages.chooseModel);
  }
  if (capability != 'chat' && capability != 'vision') {
    throw ByokiException(category: 'unknown', message: ByokiMessages.unknown);
  }
  if (input.length > 32) {
    throw ByokiException(category: 'unknown', message: ByokiMessages.tooManyMessages);
  }
  final messages = <_WireMessage>[];
  for (final message in input) {
    if (message.role != 'user' && message.role != 'assistant' && message.role != 'system') {
      throw ByokiException(category: 'unknown', message: ByokiMessages.unknown);
    }
    final parts = message.parts ?? (message.text != null ? [ByokiPart.text(message.text!)] : <ByokiPart>[]);
    if (parts.isEmpty) throw ByokiException(category: 'unknown', message: ByokiMessages.needsContent);
    if (parts.length > 8) throw ByokiException(category: 'unknown', message: ByokiMessages.tooManyParts);
    for (final part in parts) {
      if (part.type == 'text') continue;
      if (part.type != 'image' || part.mimeType == null || part.data == null) {
        throw ByokiException(category: 'unknown', message: ByokiMessages.unknown);
      }
      if (!_imageMime.contains(part.mimeType)) {
        throw ByokiException(category: 'unknown', message: ByokiMessages.mime);
      }
      if (part.data!.trim().toLowerCase().startsWith('data:')) {
        throw ByokiException(category: 'unknown', message: ByokiMessages.dataUrl);
      }
    }
    messages.add(_WireMessage(message.role, parts));
  }
  return _Prepared(
    key: key,
    provider: detected,
    modelId: model,
    messages: messages,
    timeout: timeout ?? ByokiClient.invokeTimeout,
    maxOutputTokens: maxOutputTokens,
  );
}

Map<String, String> _auth(String provider, String key) {
  switch (provider) {
    case 'openai':
      return {'authorization': 'Bearer $key'};
    case 'anthropic':
      return {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
    case 'gemini':
      return {'x-goog-api-key': key};
    default:
      throw ByokiException(category: 'invalid_key', message: ByokiMessages.invalidKey, code: 'INVALID_KEY');
  }
}

Uri _testUri(String provider) {
  switch (provider) {
    case 'openai':
      return Uri.parse('https://api.openai.com/v1/models');
    case 'anthropic':
      return Uri.parse('https://api.anthropic.com/v1/models?limit=1');
    case 'gemini':
      return Uri.parse('https://generativelanguage.googleapis.com/v1beta/models');
    default:
      throw ByokiException(category: 'invalid_key', message: ByokiMessages.invalidKey, code: 'INVALID_KEY');
  }
}

Uri _invokeUri(String provider, String modelId, {required bool stream}) {
  switch (provider) {
    case 'openai':
      return Uri.parse('https://api.openai.com/v1/chat/completions');
    case 'anthropic':
      return Uri.parse('https://api.anthropic.com/v1/messages');
    case 'gemini':
      final method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      return Uri.parse('https://generativelanguage.googleapis.com/v1beta/models/$modelId:$method');
    default:
      throw ByokiException(category: 'invalid_key', message: ByokiMessages.invalidKey, code: 'INVALID_KEY');
  }
}

Map<String, Object?> _body(_Prepared prepared, {required bool stream}) {
  switch (prepared.provider) {
    case 'openai':
      return {
        'model': prepared.modelId,
        'messages': prepared.messages
            .map(
              (message) => {
                'role': message.role,
                'content': message.parts.map(_openAiPart).toList(),
              },
            )
            .toList(),
        if (prepared.maxOutputTokens != null) 'max_completion_tokens': prepared.maxOutputTokens,
        if (stream) 'stream': true,
        if (stream) 'stream_options': {'include_usage': true},
      };
    case 'anthropic':
      final system = prepared.messages
          .where((message) => message.role == 'system')
          .expand((message) => message.parts.where((part) => part.type == 'text').map((part) => part.text ?? ''))
          .where((text) => text.isNotEmpty)
          .join('\n');
      return {
        'model': prepared.modelId,
        'max_tokens': prepared.maxOutputTokens ?? 1024,
        if (system.isNotEmpty) 'system': system,
        'messages': prepared.messages
            .where((message) => message.role != 'system')
            .map(
              (message) => {
                'role': message.role,
                'content': message.parts.map(_anthropicPart).toList(),
              },
            )
            .toList(),
        if (stream) 'stream': true,
      };
    case 'gemini':
      final system = prepared.messages
          .where((message) => message.role == 'system')
          .expand((message) => message.parts.where((part) => part.type == 'text').map((part) => part.text ?? ''))
          .where((text) => text.isNotEmpty)
          .join('\n');
      return {
        if (system.isNotEmpty) 'systemInstruction': {'parts': [{'text': system}]},
        'contents': prepared.messages
            .where((message) => message.role != 'system')
            .map(
              (message) => {
                'role': message.role == 'assistant' ? 'model' : 'user',
                'parts': message.parts.map(_geminiPart).toList(),
              },
            )
            .toList(),
        if (prepared.maxOutputTokens != null) 'generationConfig': {'maxOutputTokens': prepared.maxOutputTokens},
      };
    default:
      throw ByokiException(category: 'unknown', message: ByokiMessages.unknown);
  }
}

Map<String, Object?> _openAiPart(ByokiPart part) {
  if (part.type == 'text') return {'type': 'text', 'text': part.text};
  return {
    'type': 'image_url',
    'image_url': {'url': 'data:${part.mimeType};base64,${part.data}'},
  };
}

Map<String, Object?> _anthropicPart(ByokiPart part) {
  if (part.type == 'text') return {'type': 'text', 'text': part.text};
  return {
    'type': 'image',
    'source': {'type': 'base64', 'media_type': part.mimeType, 'data': part.data},
  };
}

Map<String, Object?> _geminiPart(ByokiPart part) {
  if (part.type == 'text') return {'text': part.text};
  return {
    'inline_data': {'mime_type': part.mimeType, 'data': part.data},
  };
}

Map<String, Object?> _object(String data) {
  try {
    final parsed = jsonDecode(data);
    if (parsed is Map<String, Object?>) return parsed;
    if (parsed is Map) return parsed.map((key, value) => MapEntry(key.toString(), value));
  } catch (_) {
    throw networkFailure();
  }
  throw networkFailure();
}

void _throwIfError(Map<String, Object?> record) {
  final error = record['error'];
  if (error is Map) {
    throw classifyProviderFailure(0, jsonEncode({'error': error}));
  }
}

String _bufferedText(String provider, Map<String, Object?> record) {
  switch (provider) {
    case 'openai':
      final choices = record['choices'];
      if (choices is List && choices.isNotEmpty && choices.first is Map) {
        final message = (choices.first as Map)['message'];
        if (message is Map && message['content'] is String) return message['content'] as String;
      }
      return '';
    case 'anthropic':
      final content = record['content'];
      if (content is! List) return '';
      return content
          .whereType<Map>()
          .where((block) => block['type'] == 'text' && block['text'] is String)
          .map((block) => block['text'] as String)
          .join('\n');
    case 'gemini':
      return _geminiText(record);
    default:
      return '';
  }
}

String _geminiText(Map<String, Object?> record) {
  final candidates = record['candidates'];
  if (candidates is! List || candidates.isEmpty || candidates.first is! Map) return '';
  final content = (candidates.first as Map)['content'];
  if (content is! Map) return '';
  final parts = content['parts'];
  if (parts is! List) return '';
  return parts
      .whereType<Map>()
      .map((part) => part['text'])
      .whereType<String>()
      .where((text) => text.isNotEmpty)
      .join('\n');
}

ByokiUsage? _bufferedUsage(String provider, Map<String, Object?> record) {
  final accum = _Accum();
  switch (provider) {
    case 'openai':
      final usage = record['usage'];
      if (usage is Map) _readOpenAiUsage(usage, accum);
    case 'anthropic':
      final usage = record['usage'];
      if (usage is Map) _readAnthropicUsage(usage, accum, outputToo: true);
    case 'gemini':
      final usage = record['usageMetadata'];
      if (usage is Map) _readGeminiUsage(usage, accum);
  }
  return accum.usage;
}

String _deltaText(String provider, SseEvent event, Map<String, Object?> record) {
  switch (provider) {
    case 'openai':
      final choices = record['choices'];
      if (choices is! List || choices.isEmpty || choices.first is! Map) return '';
      final delta = (choices.first as Map)['delta'];
      if (delta is Map && delta['content'] is String) return delta['content'] as String;
      return '';
    case 'anthropic':
      final delta = record['delta'];
      if (delta is Map && delta['type'] == 'text_delta' && delta['text'] is String) {
        return delta['text'] as String;
      }
      return '';
    case 'gemini':
      return _geminiText(record);
    default:
      return '';
  }
}

void _readStreamUsage(String provider, SseEvent event, Map<String, Object?> record, _Accum accum) {
  switch (provider) {
    case 'openai':
      final usage = record['usage'];
      if (usage is Map) _readOpenAiUsage(usage, accum);
    case 'anthropic':
      if (event.event == 'message_start' || record['type'] == 'message_start') {
        final message = record['message'];
        if (message is Map && message['usage'] is Map) {
          _readAnthropicUsage(message['usage'] as Map, accum, outputToo: false);
        }
      }
      if (event.event == 'message_delta' || record['type'] == 'message_delta') {
        final usage = record['usage'];
        if (usage is Map && usage['output_tokens'] is int) accum.outputTokens = usage['output_tokens'] as int;
      }
    case 'gemini':
      final usage = record['usageMetadata'];
      if (usage is Map) _readGeminiUsage(usage, accum);
  }
}

void _readOpenAiUsage(Map<dynamic, dynamic> usage, _Accum accum) {
  if (usage['prompt_tokens'] is int) accum.inputTokens = usage['prompt_tokens'] as int;
  if (usage['completion_tokens'] is int) accum.outputTokens = usage['completion_tokens'] as int;
  final details = usage['prompt_tokens_details'];
  if (details is Map) {
    if (details['cached_tokens'] is int) accum.cacheRead = details['cached_tokens'] as int;
    if (details['cache_write_tokens'] is int) accum.cacheWrite = details['cache_write_tokens'] as int;
  }
}

void _readAnthropicUsage(Map<dynamic, dynamic> usage, _Accum accum, {required bool outputToo}) {
  if (usage['input_tokens'] is int) accum.inputTokens = usage['input_tokens'] as int;
  if (outputToo && usage['output_tokens'] is int) accum.outputTokens = usage['output_tokens'] as int;
  if (usage['cache_read_input_tokens'] is int) accum.cacheRead = usage['cache_read_input_tokens'] as int;
  if (usage['cache_creation_input_tokens'] is int) {
    accum.cacheWrite = usage['cache_creation_input_tokens'] as int;
  }
}

void _readGeminiUsage(Map<dynamic, dynamic> usage, _Accum accum) {
  if (usage['promptTokenCount'] is int) accum.inputTokens = usage['promptTokenCount'] as int;
  if (usage['candidatesTokenCount'] is int) accum.outputTokens = usage['candidatesTokenCount'] as int;
  if (usage['cachedContentTokenCount'] is int) accum.cacheRead = usage['cachedContentTokenCount'] as int;
}
