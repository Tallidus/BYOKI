import 'detect.dart';

/// Device storage for a provider key and the chosen model ids.
///
/// Implementations must keep the key in platform secure storage. The API key
/// is a value, never the storage name.
abstract class ByokiKeyStore {
  Future<void> saveKey(String provider, String apiKey);
  Future<String?> readKey(String provider);
  Future<void> deleteKey(String provider);
  Future<void> saveModel(String provider, String capability, String modelId);
  Future<String?> readModel(String provider, String capability);
  Future<void> deleteModels(String provider);
}

/// In-memory store for tests and for a session that must not touch disk.
class MemoryByokiKeyStore implements ByokiKeyStore {
  final _keys = <String, String>{};
  final _models = <String, String>{};

  @override
  Future<void> saveKey(String provider, String apiKey) async {
    _check(provider);
    _keys[byokiKeyName(provider)] = apiKey;
  }

  @override
  Future<String?> readKey(String provider) async {
    _check(provider);
    return _keys[byokiKeyName(provider)];
  }

  @override
  Future<void> deleteKey(String provider) async {
    _check(provider);
    _keys.remove(byokiKeyName(provider));
  }

  @override
  Future<void> saveModel(String provider, String capability, String modelId) async {
    _check(provider);
    _models[byokiModelName(provider, capability)] = modelId;
  }

  @override
  Future<String?> readModel(String provider, String capability) async {
    _check(provider);
    return _models[byokiModelName(provider, capability)];
  }

  @override
  Future<void> deleteModels(String provider) async {
    _check(provider);
    _models.remove(byokiModelName(provider, 'chat'));
    _models.remove(byokiModelName(provider, 'vision'));
  }

  /// Names currently used. Tests use this to prove the API key is not a name.
  Iterable<String> get names => [..._keys.keys, ..._models.keys];
}

String byokiKeyName(String provider) => 'byoki.v1.key.$provider';

String byokiModelName(String provider, String capability) => 'byoki.v1.model.$provider.$capability';

void _check(String provider) {
  if (!byokiProviderIds.contains(provider)) {
    throw ArgumentError.value(provider, 'provider', 'Expected openai, anthropic, or gemini.');
  }
}
