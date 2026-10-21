import 'package:flutter/material.dart';

import 'catalog.dart';
import 'client.dart';
import 'detect.dart';
import 'discover.dart';
import 'errors.dart';
import 'secure_store.dart';
import 'storage.dart';

/// A model the app has tested for one capability.
class ByokiRecommendation {
  const ByokiRecommendation({required this.provider, required this.modelId, this.displayName});

  final String provider;
  final String modelId;
  final String? displayName;
}

/// Drop-in settings: paste a key, detect the provider, test it, pick a model, remove it.
///
/// The key stays in [store]. After a successful save the field is cleared and the key is not shown again.
/// Model choices and acknowledgments stay on the device.
class ByokiSettings extends StatefulWidget {
  const ByokiSettings({
    super.key,
    this.client,
    this.store,
    this.capabilities = const ['chat'],
    this.recommended = const {},
    this.defaultModels = const {},
  });

  final ByokiClient? client;
  final ByokiKeyStore? store;
  final List<String> capabilities;

  /// Recommended model ids per capability. Keys are capability names.
  final Map<String, List<ByokiRecommendation>> recommended;

  /// Default model id per capability, used when the user has not chosen.
  final Map<String, String> defaultModels;

  @override
  State<ByokiSettings> createState() => ByokiSettingsState();
}

class ByokiSettingsState extends State<ByokiSettings> {
  final _controller = TextEditingController();
  late final ByokiClient _client;
  late final ByokiKeyStore _store;
  late final bool _ownsClient;
  late final Map<String, TextEditingController> _custom;

  var _ready = false;
  var _busy = false;
  var _fallback = false;
  var _loadedList = false;
  String? _savedProvider;
  String? _error;
  var _selected = <String, String>{};
  var _listed = <ByokiModel>[];

  @override
  void initState() {
    super.initState();
    _ownsClient = widget.client == null;
    _client = widget.client ?? ByokiClient();
    _store = widget.store ?? SecureByokiKeyStore();
    _custom = {for (final capability in widget.capabilities) capability: TextEditingController()};
    _controller.addListener(() {
      if (mounted) setState(() {});
    });
    _load();
  }

  @override
  void dispose() {
    _controller.dispose();
    for (final controller in _custom.values) {
      controller.dispose();
    }
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
      await _refresh(provider, stored);
      if (!mounted) return;
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

  Future<void> _refresh(String provider, String apiKey) async {
    final result = await _client.discoverModels(apiKey);
    if (!mounted) return;
    _listed = result.models.where((model) => model.provider == provider).toList();
    _fallback = result.fallback;
    _loadedList = true;
  }

  List<ByokiModel> _visible(String provider, String capability) {
    final source = _loadedList ? _listed : _client.models(provider: provider, capability: capability);
    return source.where((model) => model.provider == provider && model.capabilities.contains(capability)).toList();
  }

  List<ByokiRecommendation> _recommended(String provider, String capability) {
    return (widget.recommended[capability] ?? []).where((model) => model.provider == provider).toList();
  }

  String? _choose(String provider, String capability, String? saved) {
    if (saved != null && saved.isNotEmpty) return saved;
    final preferred = widget.defaultModels[capability];
    final visible = _visible(provider, capability);
    if (preferred != null && (visible.any((model) => model.id == preferred) || _recommended(provider, capability).any((model) => model.modelId == preferred))) {
      return preferred;
    }
    final recommended = _recommended(provider, capability);
    if (recommended.isNotEmpty) return recommended.first.modelId;
    if (visible.isEmpty) return null;
    return visible.first.id;
  }

  String _labelFor(String provider, String modelId) {
    for (final model in _listed) {
      if (model.provider == provider && model.id == modelId) return model.displayName;
    }
    for (final capability in widget.capabilities) {
      for (final model in _recommended(provider, capability)) {
        if (model.modelId == modelId && model.displayName != null) return model.displayName!;
      }
    }
    for (final model in byokiCatalog) {
      if (model.provider == provider && model.id == modelId) return model.displayName;
    }
    return modelId;
  }

  bool _needsAck(String provider, String capability, String modelId) {
    final recommended = _recommended(provider, capability);
    if (recommended.any((model) => model.modelId == modelId)) return false;
    final listed = _visible(provider, capability).any((model) => model.id == modelId);
    if (recommended.isEmpty && listed) return false;
    return true;
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
      await _refresh(provider, key);
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
      _listed = [];
      _fallback = false;
      _loadedList = false;
      _busy = false;
      _error = null;
    });
  }

  Future<void> _select(String capability, String? modelId) async {
    final provider = _savedProvider;
    final chosen = modelId?.trim();
    if (provider == null || chosen == null || chosen.isEmpty) return;
    if (!RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(chosen)) {
      setState(() => _error = ByokiMessages.chooseModel);
      return;
    }
    if (_needsAck(provider, capability, chosen) && !await _store.hasAck(provider, chosen)) {
      if (!mounted) return;
      final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          content: const Text(byokiNotRecommended),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
            TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Use this model')),
          ],
        ),
      );
      if (accepted != true || !mounted) return;
      await _store.saveAck(provider, chosen);
    }
    await _store.saveModel(provider, capability, chosen);
    if (!mounted) return;
    setState(() {
      _selected[capability] = chosen;
      _error = null;
      _custom[capability]?.clear();
    });
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
      if (_fallback) ...[
        const SizedBox(height: 8),
        const Text("The provider model list could not be loaded. Showing the app's model list."),
      ],
      const SizedBox(height: 12),
      for (final capability in widget.capabilities) _modelPicker(provider, capability, label),
      const SizedBox(height: 12),
      TextButton(onPressed: _busy ? null : _remove, child: const Text('Remove key')),
    ];
  }

  Widget _modelPicker(String provider, String capability, String? singleLabel) {
    final recommended = _recommended(provider, capability);
    final recommendedIds = recommended.map((model) => model.modelId).toSet();
    final available = _visible(provider, capability).where((model) => !recommendedIds.contains(model.id)).toList();
    final label = singleLabel ?? 'Model for $capability';
    final selected = _selected[capability];
    final values = <String>{
      for (final model in recommended) model.modelId,
      for (final model in available) model.id,
      if (selected != null) selected,
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InputDecorator(
            decoration: InputDecoration(labelText: label),
            child: DropdownButton<String>(
              key: ValueKey('model-$capability'),
              value: selected != null && values.contains(selected) ? selected : null,
              isExpanded: true,
              items: [
                if (recommended.isNotEmpty)
                  const DropdownMenuItem(value: '__recommended__', enabled: false, child: Text('Recommended')),
                for (final model in recommended)
                  DropdownMenuItem(value: model.modelId, child: Text(model.displayName ?? _labelFor(provider, model.modelId))),
                if (available.isNotEmpty)
                  const DropdownMenuItem(value: '__available__', enabled: false, child: Text('All available models')),
                for (final model in available) DropdownMenuItem(value: model.id, child: Text(model.displayName)),
                if (selected != null && !recommendedIds.contains(selected) && available.every((model) => model.id != selected))
                  DropdownMenuItem(value: selected, child: Text(_labelFor(provider, selected))),
              ],
              onChanged: _busy
                  ? null
                  : (value) {
                      if (value == null || value.startsWith('__')) return;
                      _select(capability, value);
                    },
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            key: ValueKey('custom-$capability'),
            controller: _custom[capability],
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(labelText: 'Custom model ID'),
            onSubmitted: (value) => _select(capability, value),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _busy ? null : () => _select(capability, _custom[capability]?.text),
              child: const Text('Use custom model'),
            ),
          ),
        ],
      ),
    );
  }
}
