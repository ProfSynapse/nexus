/**
 * User-facing provider names, keyed by provider id. Dependency-free so both the
 * settings UI and the adapter layer (for error messages) can import it.
 */
export const PROVIDER_NAMES: Record<string, string> = {
  webllm: 'Nexus (Local)',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'anthropic-claude-code': 'Claude Code',
  google: 'Google AI',
  'google-gemini-cli': 'Antigravity CLI',
  mistral: 'Mistral AI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
  perplexity: 'Perplexity',
  'openai-codex': 'ChatGPT',
  'github-copilot': 'GitHub Copilot'
};
