/**
 * ModelDropdownRenderer - Shared provider + model dropdown rendering
 *
 * Extracts the duplicated pattern from ChatSettingsRenderer's
 * renderModelSection() and renderAgentModelSection() into a
 * parameterized utility.
 */

import { Setting } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';

/**
 * Provider display names shared across all model dropdown sections
 */
const PROVIDER_NAMES: Record<string, string> = {
  webllm: 'Nexus (Local)',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'anthropic-claude-code': 'Claude Code',
  google: 'Google AI',
  'google-gemini-cli': 'Gemini CLI',
  mistral: 'Mistral AI',
  groq: 'Groq',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
  perplexity: 'Perplexity',
  'openai-codex': 'ChatGPT',
  'github-copilot': 'GitHub Copilot'
};

export { PROVIDER_NAMES };

export interface ModelDropdownConfig {
  /** Section header text (e.g., "Chat model", "Subagent model") */
  sectionTitle: string;

  /** Optional description text below the header */
  description?: {
    text: string;
    infoTooltip?: string;
  };

  /** Get the list of enabled providers to show */
  getProviders: () => string[];

  /** Get the currently selected provider (may be undefined for agent) */
  getCurrentProvider: () => string | undefined;

  /** Get the currently selected model (may be undefined for agent) */
  getCurrentModel: () => string | undefined;

  /** Called when provider changes */
  onProviderChange: (provider: string | undefined) => void;

  /** Called when model changes */
  onModelChange: (model: string | undefined, provider: string | undefined) => void;

  /** Empty-state text for provider dropdown when none available */
  noProvidersText: string;

  /** Whether to show Ollama as a text input instead of dropdown */
  showOllamaTextInput: boolean;

  /** Get Ollama model name for text input display */
  getOllamaModel?: () => string;

  /** The model option map to populate (maps option key -> { provider, modelId }) */
  modelOptionMap: Map<string, { provider: string; modelId: string }>;

  /** The provider manager instance for loading models */
  providerManager: LLMProviderManager;

  /** Whether Codex OAuth is connected (for merging Codex models into OpenAI) */
  isCodexConnected: () => boolean;

  /** Whether Claude Code local auth is connected (for merging Claude Code models into Anthropic) */
  isClaudeCodeConnected: () => boolean;

  /** Whether Gemini CLI local auth is connected (for merging Gemini CLI models into Google) */
  isGeminiCliConnected: () => boolean;

  /** Get default model for a provider (async) */
  getDefaultModelForProvider: (providerId: string) => Promise<string>;

  /** Notify that settings changed */
  notifyChange: () => void;

  /** Trigger a full re-render */
  reRender: () => void;

  /** Called after provider+model dropdowns are rendered, receives the content element */
  onAfterRender?: (contentEl: HTMLElement) => void;
}

/**
 * Builds a composite option key from provider and model ID.
 * Using provider::modelId distinguishes models with the same ID from different providers.
 */
function buildModelOptionKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

/**
 * Renders a provider + model dropdown section.
 *
 * Creates the standard section structure:
 *   div.csr-section > div.csr-section-header + div.csr-section-content
 *     Setting(Provider) + Setting(Model)
 */
export function renderModelDropdownSection(
  parent: HTMLElement,
  config: ModelDropdownConfig
): void {
  const section = parent.createDiv('csr-section');
  section.createDiv('csr-section-header').setText(config.sectionTitle);

  // Optional description
  if (config.description) {
    const desc = section.createDiv('csr-section-desc');
    const descText = desc.createSpan();
    descText.setText(config.description.text);
    if (config.description.infoTooltip) {
      const infoIcon = desc.createSpan({ cls: 'csr-info-icon' });
      infoIcon.setText(' \u24D8');
      infoIcon.setAttribute('aria-label', config.description.infoTooltip);
      infoIcon.addClass('clickable-icon');
    }
  }

  const content = section.createDiv('csr-section-content');

  renderProviderDropdown(content, config);
  renderModelDropdown(content, config);

  if (config.onAfterRender) {
    config.onAfterRender(content);
  }
}

/**
 * Renders the provider dropdown Setting
 */
function renderProviderDropdown(
  content: HTMLElement,
  config: ModelDropdownConfig
): void {
  const providers = config.getProviders();
  const currentProvider = config.getCurrentProvider();
  const displayProvider = currentProvider === 'openai-codex'
    ? 'openai'
    : currentProvider === 'anthropic-claude-code'
      ? 'anthropic'
      : currentProvider === 'google-gemini-cli'
        ? 'google'
      : currentProvider;

  new Setting(content)
    .setName('Provider')
    .addDropdown(dropdown => {
      if (providers.length === 0) {
        dropdown.addOption('', config.noProvidersText);
      } else {
        if (displayProvider && !providers.includes(displayProvider)) {
          dropdown.addOption(
            displayProvider,
            `${PROVIDER_NAMES[displayProvider] || displayProvider} (Unavailable)`
          );
        }

        providers.forEach(id => {
          dropdown.addOption(id, PROVIDER_NAMES[id] || id);
        });
      }

      dropdown.setValue(displayProvider || '');
      dropdown.onChange(async (value) => {
        const newProvider = value === '' ? undefined : value;
        config.onProviderChange(newProvider);
        if (value) {
          const defaultModel = await config.getDefaultModelForProvider(value);
          config.onModelChange(defaultModel, newProvider);
        } else {
          config.onModelChange(undefined, undefined);
        }
        config.notifyChange();
        config.reRender();
      });
    });
}

/**
 * Renders the model dropdown (or text input for Ollama)
 */
function renderModelDropdown(
  content: HTMLElement,
  config: ModelDropdownConfig
): void {
  const currentProvider = config.getCurrentProvider();
  const modelProviderId = currentProvider === 'openai-codex'
    ? 'openai'
    : currentProvider === 'anthropic-claude-code'
      ? 'anthropic'
      : currentProvider === 'google-gemini-cli'
        ? 'google'
      : currentProvider;

  // Ollama special case: show text input instead of dropdown
  if (config.showOllamaTextInput && modelProviderId === 'ollama') {
    new Setting(content)
      .setName('Model')
      .addText(text => text
        .setValue(config.getOllamaModel?.() || '')
        .setDisabled(true)
        .setPlaceholder('Configure in settings'));
    return;
  }

  new Setting(content)
    .setName('Model')
    .addDropdown(async dropdown => {
      if (!modelProviderId) {
        dropdown.addOption('', 'Select a provider first');
        return;
      }

      try {
        config.modelOptionMap.clear();
        let models = await config.providerManager.getModelsForProvider(modelProviderId);

        // Merge Codex models into OpenAI list when Codex OAuth is connected
        if (modelProviderId === 'openai' && config.isCodexConnected()) {
          const codexModels = await config.providerManager.getModelsForProvider('openai-codex');
          models = [
            ...models,
            ...codexModels.map(model => ({ ...model, name: `${model.name} (ChatGPT)` }))
          ];
        }

        if (modelProviderId === 'anthropic' && config.isClaudeCodeConnected()) {
          const claudeCodeModels = await config.providerManager.getModelsForProvider('anthropic-claude-code');
          models = [
            ...models,
            ...claudeCodeModels.map(model => ({ ...model, name: `${model.name} (Claude Code)` }))
          ];
        }

        if (modelProviderId === 'google' && config.isGeminiCliConnected()) {
          const geminiCliModels = await config.providerManager.getModelsForProvider('google-gemini-cli');
          models = [
            ...models,
            ...geminiCliModels.map(model => ({ ...model, name: `${model.name} (Gemini CLI)` }))
          ];
        }

        if (models.length === 0) {
          dropdown.addOption('', 'No models available');
        } else {
          models.forEach(model => {
            const optionKey = buildModelOptionKey(model.provider, model.id);
            config.modelOptionMap.set(optionKey, { provider: model.provider, modelId: model.id });
            dropdown.addOption(optionKey, model.name);
          });

          const currentProvider = config.getCurrentProvider();
          const currentModel = config.getCurrentModel();
          const selectedOptionKey = currentProvider && currentModel
            ? buildModelOptionKey(currentProvider, currentModel)
            : '';
          const exists = selectedOptionKey ? config.modelOptionMap.has(selectedOptionKey) : false;
          if (exists) {
            dropdown.setValue(selectedOptionKey);
          } else if (currentProvider && currentModel) {
            dropdown.addOption(selectedOptionKey, `${currentModel} (Unavailable)`);
            dropdown.setValue(selectedOptionKey);
          } else if (models.length > 0) {
            const firstOptionKey = buildModelOptionKey(models[0].provider, models[0].id);
            const firstEntry = config.modelOptionMap.get(firstOptionKey);
            config.onModelChange(models[0].id, firstEntry?.provider);
            config.notifyChange();
            dropdown.setValue(firstOptionKey);
          }
        }

        dropdown.onChange((value) => {
          const entry = config.modelOptionMap.get(value);
          config.onModelChange(
            entry?.modelId ?? value,
            entry?.provider ?? modelProviderId
          );
          config.notifyChange();
          config.reRender();
        });
      } catch {
        dropdown.addOption('', 'Error loading models');
      }
    });
}
