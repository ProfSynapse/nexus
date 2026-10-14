/**
 * ModelDropdownRenderer - Shared provider + model dropdown rendering
 *
 * Provider and Model rows shared by the chat model (top block) and the
 * Subagents fold. Each function adds one Setting to a caller-owned
 * `setting-items` list and returns it.
 */

import { Setting } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { sortModelsNewestFirst } from '../../utils/modelOrdering';

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

export { PROVIDER_NAMES };

export interface ModelDropdownConfig {
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

  /** The model option map to populate (maps option key -> { provider, modelId }) */
  modelOptionMap: Map<string, { provider: string; modelId: string }>;

  /** The provider manager instance for loading models */
  providerManager: LLMProviderManager;
  /** Optional configured-instance label; builtins retain their existing labels. */
  getProviderDisplayName?: (providerId: string) => string | undefined;

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

  /**
   * The user picked a provider or model. The caller redraws only the rows that
   * depend on the selection; the dropdowns themselves are not rebuilt here.
   */
  onSelectionChanged: (kind: 'provider' | 'model') => void;

  /** Called with the model's display name once the model list has loaded. */
  onModelNameResolved?: (name: string | undefined) => void;
}

/**
 * Builds a composite option key from provider and model ID.
 * Using provider::modelId distinguishes models with the same ID from different providers.
 */
function buildModelOptionKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

/** The provider shown in the dropdown: merged sign-in providers appear under their API provider. */
export function toDisplayProvider(provider: string | undefined): string | undefined {
  if (provider === 'openai-codex') return 'openai';
  if (provider === 'anthropic-claude-code') return 'anthropic';
  if (provider === 'google-gemini-cli') return 'google';
  return provider;
}

/**
 * Adds the Provider row to a settings list (`setting-items`). No section shell,
 * heading or description; the caller owns the surrounding group.
 */
export function renderProviderSetting(itemsEl: HTMLElement, config: ModelDropdownConfig): Setting {
  return renderProviderDropdown(itemsEl, config);
}

/** Adds the Model row (dropdown, loaded asynchronously) to a settings list. */
export function renderModelSetting(itemsEl: HTMLElement, config: ModelDropdownConfig): Setting {
  return renderModelDropdown(itemsEl, config);
}

/**
 * Renders the provider dropdown Setting
 */
function renderProviderDropdown(
  content: HTMLElement,
  config: ModelDropdownConfig
): Setting {
  const providers = config.getProviders();
  const displayProvider = toDisplayProvider(config.getCurrentProvider());

  return new Setting(content)
    .setName('Provider')
    .addDropdown(dropdown => {
      if (providers.length === 0) {
        dropdown.addOption('', config.noProvidersText);
      } else {
        if (displayProvider && !providers.includes(displayProvider)) {
          dropdown.addOption(
            displayProvider,
            `${config.getProviderDisplayName?.(displayProvider) || PROVIDER_NAMES[displayProvider] || displayProvider} (Unavailable)`
          );
        }

        providers.forEach(id => {
          dropdown.addOption(id, config.getProviderDisplayName?.(id) || PROVIDER_NAMES[id] || id);
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
        config.onSelectionChanged('provider');
      });
    });
}

/**
 * Renders the model dropdown (or text input for Ollama)
 */
function renderModelDropdown(
  content: HTMLElement,
  config: ModelDropdownConfig
): Setting {
  const modelProviderId = toDisplayProvider(config.getCurrentProvider());

  return new Setting(content)
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
            ...geminiCliModels.map(model => ({ ...model, name: `${model.name} (Antigravity CLI)` }))
          ];
        }

        // Sorting is presentation-only. The provider's first model remains
        // the fallback when no selection was saved.
        const originalFirstModel = models[0];
        models = sortModelsNewestFirst(models, model => ({ provider: model.provider, id: model.id }));

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
            config.onModelNameResolved?.(models.find(model =>
              buildModelOptionKey(model.provider, model.id) === selectedOptionKey)?.name);
          } else if (currentProvider && currentModel) {
            dropdown.addOption(selectedOptionKey, `${currentModel} (Unavailable)`);
            dropdown.setValue(selectedOptionKey);
            config.onModelNameResolved?.(currentModel);
          } else if (originalFirstModel) {
            const firstOptionKey = buildModelOptionKey(originalFirstModel.provider, originalFirstModel.id);
            const firstEntry = config.modelOptionMap.get(firstOptionKey);
            config.onModelChange(originalFirstModel.id, firstEntry?.provider);
            config.notifyChange();
            dropdown.setValue(firstOptionKey);
            config.onModelNameResolved?.(originalFirstModel.name);
          }
        }

        dropdown.onChange((value) => {
          const entry = config.modelOptionMap.get(value);
          config.onModelChange(
            entry?.modelId ?? value,
            entry?.provider ?? modelProviderId
          );
          config.onModelNameResolved?.(models.find(model =>
            buildModelOptionKey(model.provider, model.id) === value)?.name);
          config.notifyChange();
          config.onSelectionChanged('model');
        });
      } catch {
        dropdown.addOption('', 'Error loading models');
      }
    });
}
