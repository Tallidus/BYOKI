import 'dart:convert';

/// Fixed visitor sentences. They never include a provider body, key, or request id.
class ByokiMessages {
  static const invalidKey = 'The provider rejected this key. Check the key and try again.';
  static const rateLimited = 'The provider rate limit was reached. Wait and try again.';
  static const quota = 'The provider quota or billing limit was reached. Check the provider account.';
  static const unavailable = 'The provider is unavailable or the request timed out. Try again later.';
  static const unknown = 'The provider request failed. Try again.';
  static const emptyKey = 'Enter a provider API key.';
  static const chooseModel = 'Choose a model.';
  static const dataUrl = 'Image data must be raw base64, not a data URL.';
  static const mime = 'Image type must be png, jpeg, webp, or gif.';
  static const tooManyMessages = 'A request can include at most 32 messages.';
  static const tooManyParts = 'A message can include at most 8 parts.';
  static const needsContent = 'Each message needs text or parts.';

  static const byCategory = <String, String>{
    'invalid_key': invalidKey,
    'rate_limited': rateLimited,
    'quota': quota,
    'unavailable': unavailable,
    'unknown': unknown,
  };
}

class ByokiException implements Exception {
  ByokiException({required this.category, required this.message, this.code});

  final String category;
  final String message;
  final String? code;

  @override
  String toString() => message;
}

const _keySignals = {
  'invalid_api_key',
  'authentication_error',
  'permission_error',
  'permission_denied',
  'unauthenticated',
  'unauthorized',
};

const _quotaSignals = {
  'insufficient_quota',
  'billing_hard_limit_reached',
  'quota_exceeded',
  'resource_exhausted',
};

const _rateSignals = {'rate_limit_exceeded', 'rate_limit_error'};

const _unavailableSignals = {
  'overloaded_error',
  'api_error',
  'server_error',
  'unavailable',
  'internal',
  'deadline_exceeded',
  'timeout',
};

/// Classify a provider failure. [body] is read only for short code fields.
ByokiException classifyProviderFailure(int status, String body) {
  final signals = _signalsFrom(body);
  bool has(Set<String> names) => signals.any(names.contains);
  if (status == 401 || status == 403 || has(_keySignals)) {
    return ByokiException(category: 'invalid_key', message: ByokiMessages.invalidKey, code: 'INVALID_KEY');
  }
  if (has(_quotaSignals) || status == 402) {
    return ByokiException(category: 'quota', message: ByokiMessages.quota, code: 'RATE_LIMITED');
  }
  if (status == 429 || has(_rateSignals)) {
    return ByokiException(category: 'rate_limited', message: ByokiMessages.rateLimited, code: 'RATE_LIMITED');
  }
  if (status == 408 || status >= 500 || has(_unavailableSignals)) {
    return ByokiException(
      category: 'unavailable',
      message: ByokiMessages.unavailable,
      code: 'UPSTREAM_UNAVAILABLE',
    );
  }
  return ByokiException(category: 'unknown', message: ByokiMessages.unknown, code: 'UPSTREAM_UNAVAILABLE');
}

ByokiException networkFailure() {
  return ByokiException(
    category: 'unavailable',
    message: ByokiMessages.unavailable,
    code: 'UPSTREAM_UNAVAILABLE',
  );
}

List<String> _signalsFrom(String body) {
  Object? parsed;
  try {
    parsed = jsonDecode(body);
  } catch (_) {
    return const [];
  }
  if (parsed is! Map) return const [];
  final signals = <String>[];
  void take(Object? value) {
    if (value is String && value.isNotEmpty && value.length <= 80) {
      signals.add(value.toLowerCase());
    }
  }

  final error = parsed['error'];
  if (error is Map) {
    take(error['code']);
    take(error['type']);
    take(error['status']);
  }
  take(parsed['code']);
  take(parsed['status']);
  take(parsed['type']);
  return signals;
}
