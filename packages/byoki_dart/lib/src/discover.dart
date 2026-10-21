import 'dart:convert';

import 'catalog.dart';

const byokiCapabilities = ['chat', 'vision', 'image', 'embedding', 'audio'];

/// Shown before a non-recommended model is saved.
const byokiNotRecommended =
    "This model isn't recommended for this app. It may produce unexpected results, and you're responsible for its output.";

class ByokiDiscovery {
  const ByokiDiscovery({required this.models, required this.source, required this.fallback});

  final List<ByokiModel> models;
  final String source;
  final bool fallback;
}

class ByokiListMetadata {
  const ByokiListMetadata({this.displayName, this.imageInput, this.methods = const []});

  final String? displayName;
  final bool? imageInput;
  final List<String> methods;
}

/// Same rules as `categorizeModel` in `@byoki/core`. Metadata wins; names fill the gaps.
List<String> categorizeByokiModel(String provider, String id, [ByokiListMetadata metadata = const ByokiListMetadata()]) {
  final idLower = id.toLowerCase();
  final methods = metadata.methods.map((method) => method.toLowerCase()).toSet();
  final embedding = idLower.contains('embed') || methods.any((method) => method.contains('embed'));
  final audioOnly = RegExp(r'whisper|transcri|^tts-|^tts$').hasMatch(idLower) || idLower == 'tts-1';
  final audio = audioOnly ||
      RegExp(r'(^|[^a-z])(audio|speech|realtime)([^a-z]|$)|-tts$').hasMatch(idLower) ||
      methods.any((method) => method.contains('bidigenerate'));
  final imageGen = RegExp(r'dall-e|dalle|gpt-image|imagen|flash-image|image-preview').hasMatch(idLower) ||
      RegExp(r'-image($|-)').hasMatch(idLower) ||
      methods.any((method) => method.contains('generateimage'));
  final methodChat = methods.contains('generatecontent') || methods.contains('streamgeneratecontent');
  final chatFamily = (provider == 'openai' &&
          RegExp(r'^(gpt-|o[0-9]|chatgpt-)').hasMatch(idLower) &&
          !idLower.startsWith('gpt-image')) ||
      (provider == 'anthropic' && idLower.startsWith('claude')) ||
      (provider == 'gemini' && RegExp(r'^(gemini|gemma|learnlm)').hasMatch(idLower));
  final exclusive = embedding || audioOnly || (imageGen && !methodChat && provider != 'gemini');
  final caps = <String>{};
  if (embedding) caps.add('embedding');
  if (audio) caps.add('audio');
  if (imageGen) caps.add('image');
  if (!exclusive && (chatFamily || methodChat) && !(imageGen && !methodChat && provider != 'gemini')) {
    caps.add('chat');
  }
  if (metadata.imageInput == true) {
    caps.add('vision');
  } else if (metadata.imageInput != false && caps.contains('chat') && !embedding && !audioOnly) {
    if (idLower.contains('vision')) caps.add('vision');
    if (provider == 'openai' && RegExp(r'gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[3-9]|chatgpt-4o').hasMatch(idLower)) {
      caps.add('vision');
    }
    if (provider == 'gemini') caps.add('vision');
    if (provider == 'anthropic') caps.add('vision');
  }
  return [for (final capability in byokiCapabilities) if (caps.contains(capability)) capability];
}

String byokiKeyFingerprint(String apiKey) {
  var hash = 5381;
  for (final unit in apiKey.codeUnits) {
    hash = ((hash << 5) + hash) ^ unit;
  }
  return (hash & 0x7fffffff).toRadixString(16);
}

List<ByokiModel> mergeDiscoveredModels(List<ByokiModel> discovered, List<ByokiModel> catalog) {
  return [
    for (final model in discovered)
      () {
        ByokiModel? known;
        for (final item in catalog) {
          if (item.provider == model.provider && item.id == model.id) {
            known = item;
            break;
          }
        }
        if (known == null) return model;
        final capabilities = [
          for (final capability in byokiCapabilities)
            if (model.capabilities.contains(capability) || known.capabilities.contains(capability)) capability,
        ];
        return ByokiModel(
          id: model.id,
          provider: model.provider,
          displayName: known.displayName,
          capabilities: capabilities,
        );
      }(),
  ];
}

/// Parameter the provider rejected, or null. The provider sentence is not returned.
String? unsupportedParameterName(String body) {
  final parsed = _object(body);
  if (parsed == null) return null;
  final error = parsed['error'];
  if (error is! Map) return null;
  final code = error['code'] is String ? (error['code'] as String).toLowerCase() : '';
  final status = error['status'] is String ? (error['status'] as String).toLowerCase() : '';
  final param = error['param'] is String ? error['param'] as String : '';
  final message = error['message'] is String ? error['message'] as String : '';
  final unsupported = code == 'unsupported_parameter' || code == 'unsupported_value';
  if (unsupported && param.isNotEmpty && param.length <= 80) return param;
  final quoted = RegExp(r"unsupported parameter:\s*'([^']+)'", caseSensitive: false).firstMatch(message);
  if (quoted != null && (quoted.group(1)?.length ?? 0) <= 80) return quoted.group(1);
  if (unsupported && message.toLowerCase().contains('temperature')) return 'temperature';
  if (RegExp(r'max_completion_tokens', caseSensitive: false).hasMatch(message) &&
      RegExp(r'not supported|unsupported', caseSensitive: false).hasMatch(message)) {
    return 'max_completion_tokens';
  }
  if (RegExp(r'max_tokens', caseSensitive: false).hasMatch(message) &&
      RegExp(r'not supported|unsupported', caseSensitive: false).hasMatch(message) &&
      !RegExp(r'max_completion_tokens', caseSensitive: false).hasMatch(message)) {
    return 'max_tokens';
  }
  if (status == 'invalid_argument' || code == 'invalid_argument') {
    if (RegExp(r'temperature', caseSensitive: false).hasMatch(message) &&
        RegExp(r'not supported|unknown|invalid', caseSensitive: false).hasMatch(message)) {
      return 'temperature';
    }
    if (RegExp(r'maxoutputtokens', caseSensitive: false).hasMatch(message) &&
        RegExp(r'not supported|unknown|invalid', caseSensitive: false).hasMatch(message)) {
      return 'maxOutputTokens';
    }
  }
  return null;
}

class ByokiParamAttempt {
  ByokiParamAttempt(this.omit, this.tokenField);

  final Set<String> omit;
  final String tokenField;
}

ByokiParamAttempt? nextByokiAttempt(ByokiParamAttempt attempt, String body) {
  final raw = unsupportedParameterName(body);
  if (raw == null) return null;
  final name = raw.split('.').last;
  final omit = {...attempt.omit};
  var tokenField = attempt.tokenField;
  if (name == 'max_completion_tokens' || name == 'max_tokens') {
    final other = name == 'max_completion_tokens' ? 'max_tokens' : 'max_completion_tokens';
    if (omit.contains(name) && omit.contains(other)) return null;
    omit.add(name);
    if (!omit.contains(other)) tokenField = other;
    if (omit.length == attempt.omit.length && tokenField == attempt.tokenField) return null;
    return ByokiParamAttempt(omit, tokenField);
  }
  if (name == 'generationConfig') {
    if (omit.contains('generationConfig')) return null;
    omit.addAll(['generationConfig', 'temperature', 'maxOutputTokens']);
    return ByokiParamAttempt(omit, tokenField);
  }
  if (omit.contains(name)) return null;
  omit.add(name);
  return ByokiParamAttempt(omit, tokenField);
}

bool isTaskMismatchBody(String body) {
  var message = body;
  final parsed = _object(body);
  if (parsed != null && parsed['error'] is Map) {
    final error = parsed['error'] as Map;
    final code = error['code'] is String ? (error['code'] as String).toLowerCase() : '';
    if (code == 'unsupported_parameter' || code == 'unsupported_value') return false;
    if (error['message'] is String) message = error['message'] as String;
  }
  return RegExp(r'does not support image', caseSensitive: false).hasMatch(message) ||
      RegExp(r'image_url is only supported', caseSensitive: false).hasMatch(message) ||
      RegExp(r'not a chat model', caseSensitive: false).hasMatch(message) ||
      RegExp(r'only supports? embed', caseSensitive: false).hasMatch(message) ||
      RegExp(r'cannot be used with (?:the )?(?:chat completions|messages|generatecontent)', caseSensitive: false)
          .hasMatch(message) ||
      RegExp(r'model does not support', caseSensitive: false).hasMatch(message) ||
      RegExp(r'not supported for (?:chat|text)', caseSensitive: false).hasMatch(message);
}

Map<String, Object?>? _object(String body) {
  try {
    final parsed = jsonDecode(body);
    if (parsed is Map<String, Object?>) return parsed;
    if (parsed is Map) return parsed.map((key, value) => MapEntry(key.toString(), value));
  } catch (_) {
    return null;
  }
  return null;
}

bool byokiModelIdOk(String modelId) => RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(modelId);

List<ByokiModel> modelsFromProviderBody(String provider, String body) {
  final parsed = _object(body);
  if (parsed == null) return const [];
  if (provider == 'openai' || provider == 'anthropic') {
    final data = parsed['data'];
    if (data is! List) return const [];
    return [
      for (final item in data)
        if (item is Map && item['id'] is String && byokiModelIdOk(item['id'] as String))
          _fromRow(provider, item),
    ];
  }
  final models = parsed['models'];
  if (models is! List) return const [];
  return [
    for (final item in models)
      if (item is Map && item['name'] is String)
        () {
          final id = (item['name'] as String).replaceFirst(RegExp(r'^models/'), '');
          if (!byokiModelIdOk(id)) return null;
          final methods = item['supportedGenerationMethods'];
          return ByokiModel(
            id: id,
            provider: provider,
            displayName: item['displayName'] is String ? item['displayName'] as String : id,
            capabilities: categorizeByokiModel(
              provider,
              id,
              ByokiListMetadata(
                displayName: item['displayName'] is String ? item['displayName'] as String : null,
                methods: methods is List ? [for (final method in methods) if (method is String) method] : const [],
              ),
            ),
          );
        }(),
  ].whereType<ByokiModel>().toList();
}

ByokiModel _fromRow(String provider, Map<dynamic, dynamic> item) {
  final id = item['id'] as String;
  bool? imageInput;
  final capabilities = item['capabilities'];
  if (capabilities is Map) {
    final image = capabilities['image_input'];
    if (image is Map && image['supported'] is bool) imageInput = image['supported'] as bool;
  }
  final display = item['display_name'] is String ? item['display_name'] as String : id;
  return ByokiModel(
    id: id,
    provider: provider,
    displayName: display,
    capabilities: categorizeByokiModel(provider, id, ByokiListMetadata(displayName: display, imageInput: imageInput)),
  );
}

String? providerPageCursor(String provider, String body) {
  final parsed = _object(body);
  if (parsed == null) return null;
  if (provider == 'anthropic') {
    if (parsed['has_more'] == true && parsed['last_id'] is String) return parsed['last_id'] as String;
    return null;
  }
  if (provider == 'gemini' && parsed['nextPageToken'] is String && (parsed['nextPageToken'] as String).isNotEmpty) {
    return parsed['nextPageToken'] as String;
  }
  return null;
}
