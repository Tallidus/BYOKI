import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'detect.dart';
import 'storage.dart';

/// Small box so tests can record storage names without the platform plugin.
abstract class ByokiSecureBox {
  Future<void> write(String key, String value);
  Future<String?> read(String key);
  Future<void> delete(String key);
}

class FlutterSecureBox implements ByokiSecureBox {
  FlutterSecureBox([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Stores keys with `flutter_secure_storage` under `byoki.v1.key.<provider>`.
class SecureByokiKeyStore implements ByokiKeyStore {
  SecureByokiKeyStore({FlutterSecureStorage? storage}) : _box = FlutterSecureBox(storage);

  SecureByokiKeyStore.box(this._box);

  final ByokiSecureBox _box;

  @override
  Future<void> saveKey(String provider, String apiKey) {
    _check(provider);
    return _box.write(byokiKeyName(provider), apiKey);
  }

  @override
  Future<String?> readKey(String provider) {
    _check(provider);
    return _box.read(byokiKeyName(provider));
  }

  @override
  Future<void> deleteKey(String provider) {
    _check(provider);
    return _box.delete(byokiKeyName(provider));
  }

  @override
  Future<void> saveModel(String provider, String capability, String modelId) {
    _check(provider);
    return _box.write(byokiModelName(provider, capability), modelId);
  }

  @override
  Future<String?> readModel(String provider, String capability) {
    _check(provider);
    return _box.read(byokiModelName(provider, capability));
  }

  @override
  Future<void> deleteModels(String provider) async {
    _check(provider);
    await _box.delete(byokiModelName(provider, 'chat'));
    await _box.delete(byokiModelName(provider, 'vision'));
  }
}

void _check(String provider) {
  if (!byokiProviderIds.contains(provider)) {
    throw ArgumentError.value(provider, 'provider', 'Expected openai, anthropic, or gemini.');
  }
}
