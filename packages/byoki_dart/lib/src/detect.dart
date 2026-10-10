/// Prefix-only detection. `sk-ant-` is checked before `sk-`.
///
/// An unrecognized key must not be sent to any network.
String? detectProvider(String apiKey) {
  final key = apiKey.trim();
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  if (key.startsWith('AIza')) return 'gemini';
  return null;
}

const byokiProviderIds = ['openai', 'anthropic', 'gemini'];

String byokiProviderName(String provider) {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    default:
      return provider;
  }
}
