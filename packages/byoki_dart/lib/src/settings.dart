import 'package:flutter/material.dart';

import 'client.dart';
import 'detect.dart';
import 'errors.dart';
import 'secure_store.dart';
import 'storage.dart';

/// Drop-in settings: paste a key, detect the provider, test it, pick a model, remove it.
///
/// The key stays in [store]. After a successful save the field is cleared and the key is not shown again.
class ByokiSettings extends StatefulWidget {
  const ByokiSettings({super.key, this.client, this.store, this.capabilities = const ['chat']});

  final ByokiClient? client;
  final ByokiKeyStore? store;
  final List<String> capabilities;

  @override
  State<ByokiSettings> createState() => ByokiSettingsState();
}

class ByokiSettingsState extends State<ByokiSettings> {
  final _controller = TextEditingController();
  late final ByokiClient _client;
  late final ByokiKeyStore _store;
  late final bool _ownsClient;

  var _ready = false;
  var _busy = false;
  String? _savedProvider;
  String? _error;
  var _selected = <String, String>{};

  @override
  void initState() {
    super.initState();
    _ownsClient = widget.client == null;
    _client = widget.client ?? ByokiClient();
    _store = widget.store ?? SecureByokiKeyStore();
    _controller.addListener(() {
      if (mounted) setState(() {});
    });
    _load();
  }

  @override
  void dispose() {
    _controller.dispose();
    if (_ownsClient) _client.close();
    super.dispose();
  }

  bool get _canTest {
    final text = _controller.text.trim();
    return !_busy && text.length >= 8 && detectProvider(text) != null;
  }

  Future<void> _load() async {
    for (final provider in byokiProviderIds) {
      final stored = await _store.readKey(provider);
      if (!mounted) return;
      if (stored == null || stored.isEmpty) continue;
      final selected = <String, String>{};
      for (final capability in widget.capabilities) {
        final saved = await _store.readModel(provider, capability);
        if (!mounted) return;
        final chosen = _choose(provider, capability, saved);
        if (chosen != null) selected[capability] = chosen;
      }
      if (!mounted) return;
      setState(() {
        _savedProvider = provider;
        _selected = selected;
        _ready = true;
      });
      return;
    }
    if (!mounted) return;
    setState(() => _ready = true);
  }

  String? _choose(String provider, String capability, String? saved) {
    final models = _client.models(provider: provider, capability: capability);
    if (saved != null && models.any((model) => model.id == saved)) return saved;
    if (models.isEmpty) return null;
    return models.first.id;
  }

  Future<void> _save() async {
    final key = _controller.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await _client.testKey(key);
      if (!mounted) return;
      if (!result.ok || result.provider == null) {
        setState(() {
          _busy = false;
          _error = result.message ?? ByokiMessages.unknown;
        });
        return;
      }
      final provider = result.provider!;
      await _store.saveKey(provider, key);
      final selected = <String, String>{};
      for (final capability in widget.capabilities) {
        if (!mounted) return;
        final existing = await _store.readModel(provider, capability);
        final chosen = _choose(provider, capability, existing);
        if (chosen == null) continue;
        await _store.saveModel(provider, capability, chosen);
        selected[capability] = chosen;
      }
      if (!mounted) return;
      _controller.clear();
      setState(() {
        _savedProvider = provider;
        _selected = selected;
        _busy = false;
        _error = null;
      });
    } on ByokiException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.message;
      });
    }
  }

  Future<void> _remove() async {
    final provider = _savedProvider;
    if (provider == null || _busy) return;
    setState(() => _busy = true);
    await _store.deleteKey(provider);
    await _store.deleteModels(provider);
    if (!mounted) return;
    setState(() {
      _savedProvider = null;
      _selected = {};
      _busy = false;
      _error = null;
    });
  }

  Future<void> _select(String capability, String? modelId) async {
    final provider = _savedProvider;
    if (provider == null || modelId == null) return;
    await _store.saveModel(provider, capability, modelId);
    if (!mounted) return;
    setState(() => _selected[capability] = modelId);
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) return const LinearProgressIndicator();
    final saved = _savedProvider;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (saved == null) ..._entry(),
        if (saved != null) ..._saved(saved),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, key: const Key('byoki-error')),
        ],
      ],
    );
  }

  List<Widget> _entry() {
    final detected = detectProvider(_controller.text);
    return [
      TextField(
        controller: _controller,
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        spellCheckConfiguration: SpellCheckConfiguration.disabled(),
        decoration: const InputDecoration(labelText: 'Provider API key'),
      ),
      if (_controller.text.trim().isNotEmpty) ...[
        const SizedBox(height: 8),
        Text(detected == null ? 'Unrecognized key' : byokiProviderName(detected)),
      ],
      const SizedBox(height: 12),
      FilledButton(onPressed: _canTest ? _save : null, child: const Text('Test and save')),
      if (_busy) const LinearProgressIndicator(),
    ];
  }

  List<Widget> _saved(String provider) {
    final label = widget.capabilities.length == 1 ? 'Model' : null;
    return [
      Text('${byokiProviderName(provider)} key saved'),
      const SizedBox(height: 12),
      for (final capability in widget.capabilities) _modelPicker(provider, capability, label),
      const SizedBox(height: 12),
      TextButton(onPressed: _busy ? null : _remove, child: const Text('Remove key')),
    ];
  }

  Widget _modelPicker(String provider, String capability, String? singleLabel) {
    final models = _client.models(provider: provider, capability: capability);
    final label = singleLabel ?? 'Model for $capability';
    final selected = _selected[capability];
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InputDecorator(
        decoration: InputDecoration(labelText: label),
        child: DropdownButton<String>(
          key: ValueKey('model-$capability'),
          value: models.any((model) => model.id == selected) ? selected : null,
          isExpanded: true,
          items: [
            for (final model in models) DropdownMenuItem(value: model.id, child: Text(model.displayName)),
          ],
          onChanged: _busy ? null : (value) => _select(capability, value),
        ),
      ),
    );
  }
}
