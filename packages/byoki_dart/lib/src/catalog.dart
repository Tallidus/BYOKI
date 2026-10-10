class ByokiModel {
  const ByokiModel({
    required this.id,
    required this.provider,
    required this.displayName,
    required this.capabilities,
  });

  final String id;
  final String provider;
  final String displayName;
  final List<String> capabilities;
}

const byokiCatalogUpdatedAt = '2026-09-25T00:00:00.000Z';

const byokiCatalog = <ByokiModel>[
  ByokiModel(
    id: 'gpt-5.6-terra',
    provider: 'openai',
    displayName: 'GPT-5.6 Terra',
    capabilities: ['chat', 'vision'],
  ),
  ByokiModel(
    id: 'gpt-5.6-luna',
    provider: 'openai',
    displayName: 'GPT-5.6 Luna',
    capabilities: ['chat', 'vision'],
  ),
  ByokiModel(
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5',
    capabilities: ['chat', 'vision'],
  ),
  ByokiModel(
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    capabilities: ['chat', 'vision'],
  ),
  ByokiModel(
    id: 'gemini-3.5-flash',
    provider: 'gemini',
    displayName: 'Gemini 3.5 Flash',
    capabilities: ['chat', 'vision'],
  ),
  ByokiModel(
    id: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    displayName: 'Gemini 3.1 Flash-Lite',
    capabilities: ['chat', 'vision'],
  ),
];
