import 'detect.dart';
import 'discover.dart';

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
  Future<void> saveAck(String provider, String modelId);
  Future<bool> hasAck(String provider, String modelId);
}

/// In-memory store for tests and for a session that must not touch disk.
class MemoryByokiKeyStore implements ByokiKeyStore {
  final _keys = <String, String>{};
  final _models = <String, String>{};
  final _acks = <String, String>{};

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
    for (final capability in byokiCapabilities) {
      _models.remove(byokiModelName(provider, capability));
    }
  }

  @override
  Future<void> saveAck(String provider, String modelId) async {
    _check(provider);
    _acks[byokiAckName(provider, modelId)] = '1';
  }

  @override
  Future<bool> hasAck(String provider, String modelId) async {
    _check(provider);
    return _acks[byokiAckName(provider, modelId)] == '1';
  }

  /// Names currently used. Tests use this to prove the API key is not a name.
  Iterable<String> get names => [..._keys.keys, ..._models.keys, ..._acks.keys];
}

String byokiKeyName(String provider) => 'byoki.v1.key.$provider';

String byokiModelName(String provider, String capability) => 'byoki.v1.model.$provider.$capability';

String byokiAckName(String provider, String modelId) => 'byoki.v1.ack.$provider.$modelId';

void _check(String provider) {
  if (!byokiProviderIds.contains(provider)) {
    throw ArgumentError.value(provider, 'provider', 'Expected openai, anthropic, or gemini.');
  }
}
