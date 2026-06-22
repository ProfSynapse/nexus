/**
 * ChatSettingsRenderer - Shared settings UI for DefaultsTab and ChatSettingsModal
 *
 * Renders identical UI in both places:
 * - Chat provider + model
 * - Reasoning toggle + Effort slider
 * - Image generation settings
 * - Transcription settings
 * - Workspace + prompt
 * - Context notes
 *
 * The difference is only WHERE data is saved (via callbacks).
 */

import { App, Setting, EventRef } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';
import { ImageGenerationService } from '../../services/llm/ImageGenerationService';
import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  resolveDefaultSpeechSelection,
  type SpeechProvider,
  type SpeechProviderAvailability,
} from '../../services/llm/types/SpeechTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  resolveDefaultRealtimeVoiceSelection,
  type RealtimeVoiceProviderAvailability,
} from '../../services/llm/types/RealtimeVoiceTypes';
import {
  DefaultRealtimeVoiceModelSettings,
  DefaultSpeechModelSettings,
  LLMProviderSettings,
  ThinkingEffort
} from '../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../types/apps/AppTypes';
import { isTextOnlyProvider } from '../../services/llm/utils/ToolSchemaSupport';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isDesktop, isProviderCompatible } from '../../utils/platform';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { renderModelDropdownSection } from './ModelDropdownRenderer';
import {
  getIngestCapabilityOptions,
  normalizeIngestSelection
} from '../../agents/ingestManager/tools/services/IngestCapabilityService';
import { renderIngestModelDropdowns } from './IngestModelDropdownRenderer';
import { VoiceCatalogService } from '../../services/readAloud/VoiceCatalogService';
import { SpeechModelCatalogService } from '../../services/readAloud/SpeechModelCatalogService';
import { ProviderUtils } from '../../ui/chat/utils/ProviderUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';

/**
 * Current settings state
 */
export interface ChatSettings {
  provider: string;
  model: string;
  // Subagent model - used for executePrompt when chat model is local
  agentProvider?: string;
  agentModel?: string;
  thinking: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  // Subagent model thinking settings (separate from chat model)
  agentThinking?: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  temperature: number; // 0.0-1.0, controls randomness
  imageProvider: 'google' | 'openrouter';
  imageModel: string;
  speechProvider?: DefaultSpeechModelSettings['provider'];
  speechModel?: DefaultSpeechModelSettings['model'];
  speechVoice?: DefaultSpeechModelSettings['voice'];
  realtimeVoiceProvider?: DefaultRealtimeVoiceModelSettings['provider'];
  realtimeVoiceModel?: DefaultRealtimeVoiceModelSettings['model'];
  realtimeVoiceVoice?: DefaultRealtimeVoiceModelSettings['voice'];
  transcriptionProvider?: string;
  transcriptionModel?: string;
  workspaceId: string | null;
  promptId: string | null;
  contextNotes: string[];
}

/**
 * Local providers that can't be used for executePrompt
 */
const LOCAL_PROVIDERS = ['webllm', 'ollama', 'lmstudio'];

/**
 * Available options for dropdowns
 */
export interface ChatSettingsOptions {
  workspaces: Array<{
    id: string;
    name: string;
    context?: {
      dedicatedAgent?: {
        agentId: string;
        agentName: string;
      };
    };
  }>;
  prompts: Array<{ id: string; name: string }>;
}

/**
 * Callbacks for when settings change
 */
export interface ChatSettingsCallbacks {
  onSettingsChange: (settings: ChatSettings) => void;
}

/**
 * Renderer configuration
 */
export interface ChatSettingsRendererConfig {
  app: App;
  llmProviderSettings: LLMProviderSettings;
  initialSettings: ChatSettings;
  options: ChatSettingsOptions;
  callbacks: ChatSettingsCallbacks;
  showVoiceSection?: boolean;
  showTranscriptionSection?: boolean;
  renderAfterImageSection?: (parent: HTMLElement) => void;
}

interface PluginWithAppSettings {
  settings?: {
    settings?: {
      apps?: AppsSettings;
    };
  };
}

const EFFORT_LEVELS: ThinkingEffort[] = ['low', 'medium', 'high'];
const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
};

export class ChatSettingsRenderer {
  private container: HTMLElement;
  private config: ChatSettingsRendererConfig;
  private providerManager: LLMProviderManager;
  private staticModelsService: StaticModelsService;
  private settings: ChatSettings;

  // UI references
  private effortSection?: HTMLElement;
  private agentEffortSection?: HTMLElement;
  private contextNotesListEl?: HTMLElement;
  private settingsEventRef?: EventRef;
  // Maps dropdown option value -> actual { provider, modelId } for merged model lists
  private modelOptionMap: Map<string, { provider: string; modelId: string }> = new Map();
  private agentModelOptionMap: Map<string, { provider: string; modelId: string }> = new Map();
  private imageService: ImageGenerationService;

  constructor(container: HTMLElement, config: ChatSettingsRendererConfig) {
    this.container = container;
    this.config = config;
    this.settings = { ...config.initialSettings };
    this.staticModelsService = StaticModelsService.getInstance();

    this.providerManager = new LLMProviderManager(
      config.llmProviderSettings,
      config.app.vault
    );

    this.imageService = new ImageGenerationService(config.app.vault, config.llmProviderSettings);

    this.settingsEventRef = LLMSettingsNotifier.onSettingsChanged((newSettings) => {
      this.config.llmProviderSettings = newSettings;
      this.providerManager.updateSettings(newSettings);
      this.imageService.updateSettings(newSettings);
      this.render();
    });
  }

  destroy(): void {
    if (this.settingsEventRef) {
      LLMSettingsNotifier.unsubscribe(this.settingsEventRef);
      this.settingsEventRef = undefined;
    }
  }

  render(): void {
    this.container.empty();
    this.container.addClass('chat-settings-renderer');

    // Vertical layout - order: Chat (with Reasoning), Agent, Image, Transcription, Temp, Context
    this.renderModelSection(this.container);
    this.renderAgentModelSection(this.container);
    this.renderImageSection(this.container);
    this.config.renderAfterImageSection?.(this.container);
    if (this.config.showVoiceSection !== false) {
      this.renderVoiceSection(this.container);
    } else if (this.config.showTranscriptionSection !== false) {
      this.renderTranscriptionSection(this.container);
    }
    this.renderTemperatureSection(this.container);
    this.renderContextSection(this.container);
  }

  private notifyChange(): void {
    this.config.callbacks.onSettingsChange({ ...this.settings });
  }

  private getEnabledProviders(): string[] {
    const llmSettings = this.config.llmProviderSettings;
    const providers = new Set<string>();

    for (const id of Object.keys(llmSettings.providers)) {
      if (id === 'openai-codex') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected && config?.apiKey) {
          providers.add('openai');
        }
        continue;
      }

      if (id === 'anthropic-claude-code') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected) {
          providers.add('anthropic');
        }
        continue;
      }

      if (id === 'google-gemini-cli') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected) {
          providers.add('google');
        }
        continue;
      }

      if (id === 'github-copilot') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected && config?.apiKey) {
          providers.add('github-copilot');
        }
        continue;
      }

      const config = llmSettings.providers[id];
      if (!config?.enabled) continue;
      if (!isProviderCompatible(id)) continue;

      if (id === 'webllm') {
        providers.add(id);
        continue;
      }

      if (config.apiKey) {
        providers.add(id);
      }
    }

    return Array.from(providers);
  }

  private isCodexConnected(): boolean {
    const codexConfig = this.config.llmProviderSettings.providers['openai-codex'];
    return !!(codexConfig?.oauth?.connected && codexConfig?.apiKey);
  }

  private isClaudeCodeConnected(): boolean {
    const claudeCodeConfig = this.config.llmProviderSettings.providers['anthropic-claude-code'];
    return !!claudeCodeConfig?.oauth?.connected;
  }

  private isGeminiCliConnected(): boolean {
    const geminiCliConfig = this.config.llmProviderSettings.providers['google-gemini-cli'];
    return !!geminiCliConfig?.oauth?.connected;
  }

  // ========== MODEL SECTION ==========

  private renderModelSection(parent: HTMLElement): void {
    renderModelDropdownSection(parent, {
      sectionTitle: 'Chat model',
      getProviders: () => this.getEnabledProviders(),
      getCurrentProvider: () => this.settings.provider,
      getCurrentModel: () => this.settings.model,
      onProviderChange: (provider) => {
        this.settings.provider = provider ?? '';
      },
      onModelChange: (model, provider) => {
        this.settings.model = model ?? '';
        if (provider !== undefined) {
          this.settings.provider = provider;
        }
      },
      noProvidersText: 'No providers enabled',
      showOllamaTextInput: true,
      getOllamaModel: () => this.settings.model || '',
      modelOptionMap: this.modelOptionMap,
      providerManager: this.providerManager,
      isCodexConnected: () => this.isCodexConnected(),
      isClaudeCodeConnected: () => this.isClaudeCodeConnected(),
      isGeminiCliConnected: () => this.isGeminiCliConnected(),
      getDefaultModelForProvider: (id) => this.getDefaultModelForProvider(id),
      notifyChange: () => this.notifyChange(),
      reRender: () => this.render(),
      onAfterRender: (content) => {
        this.renderReasoningControls(content);
        this.renderTextOnlyProviderWarning(content, 'chat');
      },
    });
  }

  /**
   * Render reasoning controls (toggle + effort slider) parameterized for chat or agent.
   */
  private renderReasoningControls(content: HTMLElement, variant: 'chat' | 'agent' = 'chat'): void {
    const isAgent = variant === 'agent';

    // Check model support
    const provider = isAgent ? this.settings.agentProvider : this.settings.provider;
    const model = isAgent ? this.settings.agentModel : this.settings.model;
    if (!provider || !model) return;
    const modelDef = this.staticModelsService.findModel(provider, model);
    if (!modelDef?.capabilities?.supportsThinking) return;

    // Ensure agent thinking state is initialized
    if (isAgent && !this.settings.agentThinking) {
      this.settings.agentThinking = { enabled: false, effort: 'medium' };
    }

    const getThinking = () => {
      if (isAgent) {
        if (!this.settings.agentThinking) {
          this.settings.agentThinking = { enabled: false, effort: 'medium' };
        }
        return this.settings.agentThinking;
      }

      return this.settings.thinking;
    };

    // Reasoning toggle
    new Setting(content)
      .setName('Reasoning')
      .setDesc('Think step-by-step')
      .addToggle(toggle => toggle
        .setValue(getThinking().enabled)
        .onChange(value => {
          if (isAgent && !this.settings.agentThinking) {
            this.settings.agentThinking = { enabled: false, effort: 'medium' };
          }
          getThinking().enabled = value;
          this.notifyChange();
          this.updateEffortVisibility(variant);
        }));

    // Effort slider
    const effortEl = content.createDiv('csr-effort-row');
    if (isAgent) {
      this.agentEffortSection = effortEl;
    } else {
      this.effortSection = effortEl;
    }
    if (!getThinking().enabled) {
      effortEl.addClass('is-hidden');
    }

    const effortSetting = new Setting(effortEl)
      .setName('Effort');

    const valueDisplay = effortSetting.controlEl.createSpan({ cls: 'csr-effort-value' });
    valueDisplay.setText(EFFORT_LABELS[getThinking().effort]);

    effortSetting.addSlider(slider => {
      slider
        .setLimits(0, 2, 1)
        .setValue(EFFORT_LEVELS.indexOf(getThinking().effort))
        .onChange((value: number) => {
          if (isAgent && !this.settings.agentThinking) {
            this.settings.agentThinking = { enabled: false, effort: 'medium' };
          }
          getThinking().effort = EFFORT_LEVELS[value];
          valueDisplay.setText(EFFORT_LABELS[getThinking().effort]);
          this.notifyChange();
        });
      return slider;
    });
  }

  // ========== SUBAGENT MODEL SECTION ==========

  /**
   * Render Subagent model section - always shown, excludes local providers.
   * This model is used for executePrompt and other API-dependent operations.
   */
  private renderAgentModelSection(parent: HTMLElement): void {
    renderModelDropdownSection(parent, {
      sectionTitle: 'Subagent model',
      description: {
        text: 'Cloud model for AI actions',
        infoTooltip: 'Saved prompts and automations require a cloud API.',
      },
      getProviders: () => this.getEnabledProviders().filter(id => !LOCAL_PROVIDERS.includes(id)),
      getCurrentProvider: () => this.settings.agentProvider,
      getCurrentModel: () => this.settings.agentModel,
      onProviderChange: (provider) => {
        this.settings.agentProvider = provider;
      },
      onModelChange: (model, provider) => {
        this.settings.agentModel = model;
        if (provider !== undefined) {
          this.settings.agentProvider = provider;
        }
      },
      noProvidersText: 'No cloud providers enabled',
      showOllamaTextInput: false,
      modelOptionMap: this.agentModelOptionMap,
      providerManager: this.providerManager,
      isCodexConnected: () => this.isCodexConnected(),
      isClaudeCodeConnected: () => this.isClaudeCodeConnected(),
      isGeminiCliConnected: () => this.isGeminiCliConnected(),
      getDefaultModelForProvider: (id) => this.getDefaultModelForProvider(id),
      notifyChange: () => this.notifyChange(),
      reRender: () => this.render(),
      onAfterRender: (content) => {
        this.renderReasoningControls(content, 'agent');
        this.renderTextOnlyProviderWarning(content, 'agent');
      },
    });
  }

  private renderTextOnlyProviderWarning(content: HTMLElement, variant: 'chat' | 'agent'): void {
    const provider = variant === 'agent' ? this.settings.agentProvider : this.settings.provider;
    if (!isTextOnlyProvider(provider)) {
      return;
    }

    const { title, message } = this.getTextOnlyProviderWarningCopy(provider, variant);

    const warningEl = content.createDiv({ cls: 'csr-provider-warning' });
    warningEl.createDiv({
      cls: 'csr-provider-warning-title',
      text: title
    });
    warningEl.createDiv({
      cls: 'csr-provider-warning-text',
      text: message
    });
  }

  /**
   * Calm, factual copy for a text-completion-only provider. Antigravity mentions
   * BOTH limitations (no tools/agents AND no streaming); Perplexity keeps its
   * established search-focused wording.
   */
  private getTextOnlyProviderWarningCopy(
    provider: string | undefined,
    variant: 'chat' | 'agent'
  ): { title: string; message: string } {
    if (provider === 'google-gemini-cli') {
      return {
        title: 'Antigravity is text completions only',
        message: variant === 'agent'
          ? 'This provider can\'t call tools or agents, and replies arrive all at once (no streaming). Prompt actions and subagents run in text-only mode — use another cloud model for vault edits or other tool-driven work.'
          : 'This provider can\'t call tools or agents, and replies arrive all at once (no streaming). Use it for plain text chat; switch providers for agentic, tool-driven work.'
      };
    }

    // Perplexity (and any future search/text-only provider) — preserve prior copy.
    return {
      title: 'Perplexity cannot use Nexus tools',
      message: variant === 'agent'
        ? 'Prompt actions and subagents will run in text-only mode. Use another cloud model for vault edits or other tool-driven work.'
        : 'Chat and subagents will not receive tool schemas with Perplexity. Use it for search-heavy, text-only work.'
    };
  }

  // ========== TEMPERATURE SECTION ==========

  private renderTemperatureSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Temperature');
    const content = section.createDiv('csr-section-content');

    // Create container for slider row with value display
    const tempSetting = new Setting(content)
      .setName('Creativity')
      .setDesc('Lower is more focused, higher is more creative.');

    // Add value display span
    const valueDisplay = tempSetting.controlEl.createSpan({ cls: 'csr-temp-value' });
    valueDisplay.setText(this.settings.temperature.toFixed(1));

    // Add Obsidian slider component
    tempSetting.addSlider(slider => {
      slider
        .setLimits(0, 1, 0.1)
        .setValue(this.settings.temperature)
        .setDynamicTooltip()
        .onChange((value: number) => {
          this.settings.temperature = value;
          valueDisplay.setText(value.toFixed(1));
          this.notifyChange();
        });
      return slider;
    });
  }

  private updateEffortVisibility(variant: 'chat' | 'agent' = 'chat'): void {
    const section = variant === 'agent' ? this.agentEffortSection : this.effortSection;
    if (!section) return;

    const enabled = variant === 'agent'
      ? this.settings.agentThinking?.enabled
      : this.settings.thinking.enabled;

    if (enabled) {
      section.removeClass('is-hidden');
    } else {
      section.addClass('is-hidden');
    }
  }

  // ========== IMAGE SECTION ==========

  private renderImageSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Image model');
    const content = section.createDiv('csr-section-content');

    // Provider
    new Setting(content)
      .setName('Provider')
      .addDropdown(dropdown => {
        const providers: Array<{ id: 'google' | 'openrouter'; name: string }> = isDesktop()
          ? [
            { id: 'google', name: 'Google AI' },
            { id: 'openrouter', name: 'OpenRouter' }
          ]
          : [{ id: 'openrouter', name: 'OpenRouter' }];

        // If current selection isn't supported on this platform, fall back.
        if (!providers.some(p => p.id === this.settings.imageProvider)) {
          this.settings.imageProvider = providers[0].id;
          this.settings.imageModel = '';
          // Async: pick the first model from the new provider
          void this.imageService.getModelsForProvider(this.settings.imageProvider).then(models => {
            if (models.length > 0) {
              this.settings.imageModel = models[0].id;
              this.notifyChange();
            }
          });
        }

        for (const provider of providers) {
          dropdown.addOption(provider.id, provider.name);
        }

        dropdown.setValue(this.settings.imageProvider);
        dropdown.onChange((value) => {
          this.settings.imageProvider = value as 'google' | 'openrouter';
          void this.imageService.getModelsForProvider(value as 'google' | 'openrouter').then(models => {
            this.settings.imageModel = models[0]?.id || '';
            this.notifyChange();
            this.render();
          });
        });
      });

    // Model (async — populate from adapter)
    new Setting(content)
      .setName('Model')
      .addDropdown(async dropdown => {
        const models = await this.imageService.getModelsForProvider(this.settings.imageProvider);

        if (models.length === 0) {
          dropdown.addOption('', 'No models available');
        } else {
          models.forEach(m => {
            dropdown.addOption(m.id, m.name);
          });

          const exists = models.some(m => m.id === this.settings.imageModel);
          if (exists) {
            dropdown.setValue(this.settings.imageModel);
          } else if (models.length > 0) {
            this.settings.imageModel = models[0].id;
            dropdown.setValue(this.settings.imageModel);
          }
        }

        dropdown.onChange((value) => {
          this.settings.imageModel = value;
          this.notifyChange();
        });
      });
  }

  // ========== TRANSCRIPTION SECTION ==========

  private renderTranscriptionSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Transcription model');
    const content = section.createDiv('csr-section-content');
    this.renderTranscriptionControls(content);
  }

  private renderTranscriptionControls(parent: HTMLElement): void {
    const content = parent.createDiv('csr-transcription-controls');
    content.createDiv({
      cls: 'setting-item-description',
      text: 'Loading transcription models...'
    });

    void getIngestCapabilityOptions(this.providerManager).then(capabilities => {
      content.empty();
      const normalizedSelection = normalizeIngestSelection(
        capabilities.transcriptionProviders,
        this.settings.transcriptionProvider,
        this.settings.transcriptionModel
      );

      const changed = normalizedSelection.provider !== this.settings.transcriptionProvider
        || normalizedSelection.model !== this.settings.transcriptionModel;

      this.settings.transcriptionProvider = normalizedSelection.provider;
      this.settings.transcriptionModel = normalizedSelection.model;

      if (changed) {
        this.notifyChange();
      }

      renderIngestModelDropdowns(content, {
        labelPrefix: 'Transcription',
        description: 'Model for audio transcription.',
        providers: capabilities.transcriptionProviders,
        getSelection: () => this.settings.transcriptionProvider && this.settings.transcriptionModel
          ? {
            provider: this.settings.transcriptionProvider,
            model: this.settings.transcriptionModel
          }
          : undefined,
        onChange: (provider, model) => {
          this.settings.transcriptionProvider = provider;
          this.settings.transcriptionModel = model;
          this.notifyChange();
        },
        providerSettingName: 'Provider',
        modelSettingName: 'Model'
      });
    }).catch(() => {
      content.empty();
      content.createDiv({
        cls: 'setting-item-description',
        text: 'Transcription models are not available.'
      });
    });
  }

  private renderVoiceSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Voice');
    const content = section.createDiv('csr-section-content');
    content.createDiv({
      cls: 'csr-section-desc nexus-voice-section-desc',
      text: 'Defaults for microphone input, read aloud, and live voice in this chat.'
    });

    let updateVoiceWarning = (): void => undefined;

    this.renderVoiceGroupLabel(content, 'Voice input');
    this.renderTranscriptionControls(content);

    this.renderVoiceGroupLabel(content, 'Read aloud');
    this.renderSpeechSettings(content, () => updateVoiceWarning());

    this.renderVoiceGroupLabel(content, 'Live voice');
    this.renderRealtimeVoiceSettings(content, () => updateVoiceWarning());

    const warningEl = content.createDiv({ cls: 'nexus-voice-warning is-hidden' });
    updateVoiceWarning = (): void => {
      const messages = this.getVoiceWarningMessages();
      warningEl.empty();
      warningEl.toggleClass('is-hidden', messages.length === 0);
      messages.forEach(message => {
        warningEl.createDiv({ text: message });
      });
    };
    updateVoiceWarning();
  }

  private renderVoiceGroupLabel(parentEl: HTMLElement, label: string): void {
    parentEl.createDiv({ cls: 'nexus-voice-group-label', text: label });
  }

  private renderSpeechSettings(parent: HTMLElement, onSelectionChange: () => void): void {
    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;
    let modelRequestId = 0;
    let voiceRequestId = 0;
    const voiceCatalogService = new VoiceCatalogService();
    const speechModelCatalogService = new SpeechModelCatalogService();

    const getAvailability = (): SpeechProviderAvailability[] =>
      buildSpeechProviderAvailability(this.config.llmProviderSettings, this.getSpeechAppStates());

    const getSelection = (): DefaultSpeechModelSettings => {
      const availability = getAvailability();
      const configuredProvider = this.settings.speechProvider;
      const provider = configuredProvider
        || availability.find(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0)?.provider;
      const providerAvailability = availability.find(item => item.provider === provider);
      const model = this.settings.speechModel && providerAvailability?.models?.some(candidate => candidate.id === this.settings.speechModel)
        ? this.settings.speechModel
        : providerAvailability?.models?.[0]?.id;

      return {
        provider,
        model,
        voice: this.settings.speechVoice,
        source: 'user'
      };
    };

    const updateVoiceOptions = async (): Promise<void> => {
      if (!voiceDropdown) return;
      const requestId = ++voiceRequestId;
      const selection = getSelection();

      voiceDropdown.empty();
      if (selection.provider === 'elevenlabs') {
        voiceDropdown.createEl('option', { value: '', text: 'Loading voices...' });
        voiceDropdown.disabled = true;
      }

      const voices = await voiceCatalogService.getVoices(selection.provider, selection.model, {
        llmSettings: this.config.llmProviderSettings,
        appsSettings: this.getAppsSettings()
      }).catch(() => []);

      if (requestId !== voiceRequestId || !voiceDropdown) {
        return;
      }

      voiceDropdown.empty();
      voiceDropdown.createEl('option', { value: '', text: 'Provider default' });
      voices.forEach(voice => {
        voiceDropdown?.createEl('option', { value: voice.id, text: voice.name });
      });

      if (selection.voice && !voices.some(voice => voice.id === selection.voice)) {
        voiceDropdown.createEl('option', {
          value: selection.voice,
          text: `${selection.voice} (unavailable)`
        });
      }

      voiceDropdown.disabled = !selection.provider || !selection.model;
      voiceDropdown.value = selection.voice || '';
    };

    const updateModelOptions = async (): Promise<void> => {
      if (!modelDropdown) return;
      const requestId = ++modelRequestId;
      const selection = getSelection();
      const availability = getAvailability();
      const providerAvailability = availability.find(item => item.provider === selection.provider);
      const providerUsable = providerAvailability?.enabled === true && providerAvailability.configured === true;

      modelDropdown.empty();
      if (!selection.provider) {
        modelDropdown.createEl('option', {
          value: '',
          text: 'Select a speech provider first'
        });
        modelDropdown.disabled = true;
        void updateVoiceOptions();
        return;
      }

      if (selection.provider === 'openrouter') {
        modelDropdown.createEl('option', { value: '', text: 'Loading OpenRouter speech models...' });
        modelDropdown.disabled = true;
      }

      const models = await speechModelCatalogService.getModels(
        selection.provider as SpeechProvider,
        this.config.llmProviderSettings
      ).catch(() => providerAvailability?.models ?? []);

      if (requestId !== modelRequestId || !modelDropdown) {
        return;
      }

      modelDropdown.empty();
      if (models.length === 0) {
        modelDropdown.createEl('option', {
          value: '',
          text: 'No speech models available'
        });
        modelDropdown.disabled = true;
        void updateVoiceOptions();
        return;
      }

      models.forEach(model => {
        modelDropdown?.createEl('option', { value: model.id, text: model.name });
      });

      if (selection.model && !models.some(model => model.id === selection.model)) {
        modelDropdown.createEl('option', {
          value: selection.model,
          text: `${selection.model} (unavailable)`
        });
      }

      const selectedModelExists = models.some(model => model.id === selection.model);
      const nextModel = selection.model && selectedModelExists
        ? selection.model
        : models[0]?.id || '';

      this.settings.speechProvider = selection.provider;
      this.settings.speechModel = nextModel || undefined;
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = nextModel;
      this.notifyChange();
      void updateVoiceOptions();
    };

    new Setting(parent)
      .setName('Speech provider')
      .setDesc('Normal text-to-speech models for reading chat content aloud.')
      .addDropdown(dropdown => {
        const availability = getAvailability();
        const selection = getSelection();
        const usableProviders = availability.filter(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0);

        if (usableProviders.length === 0 && !selection.provider) {
          dropdown.addOption('', 'No speech providers available');
          dropdown.setDisabled(true);
          return;
        }

        usableProviders.forEach(provider => {
          dropdown.addOption(provider.provider, this.getProviderDisplayName(provider.provider));
        });

        if (selection.provider && !usableProviders.some(provider => provider.provider === selection.provider)) {
          dropdown.addOption(
            selection.provider,
            `${this.getProviderDisplayName(selection.provider)} (unavailable)`
          );
        }

        dropdown.setValue(selection.provider || usableProviders[0]?.provider || '');
        dropdown.onChange((provider) => {
          const providerAvailability = getAvailability().find(item => item.provider === provider);
          const model = providerAvailability?.models?.[0];
          this.settings.speechProvider = provider || undefined;
          this.settings.speechModel = model?.id;
          this.settings.speechVoice = model?.defaultVoice;
          this.notifyChange();
          void updateModelOptions().then(onSelectionChange);
        });
      });

    new Setting(parent)
      .setName('Speech model')
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        void updateModelOptions();
        dropdown.onChange((modelId) => {
          const selection = getSelection();
          const model = getSpeechModel(selection.provider, modelId);
          this.settings.speechModel = modelId || undefined;
          if (model) {
            this.settings.speechVoice = this.settings.speechVoice || model.defaultVoice;
          }
          this.notifyChange();
          void updateVoiceOptions().then(onSelectionChange);
        });
      });

    new Setting(parent)
      .setName('Speech voice')
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        void updateVoiceOptions();
        dropdown.onChange((voice) => {
          this.settings.speechVoice = voice || undefined;
          this.notifyChange();
          onSelectionChange();
        });
      });
  }

  private renderRealtimeVoiceSettings(parent: HTMLElement, onSelectionChange: () => void): void {
    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;

    const getAvailability = (): RealtimeVoiceProviderAvailability[] =>
      buildRealtimeVoiceProviderAvailability(this.config.llmProviderSettings, this.getRealtimeAppStates());

    const getSelection = (): DefaultRealtimeVoiceModelSettings => {
      const availability = getAvailability();
      const configuredProvider = this.settings.realtimeVoiceProvider;
      const provider = configuredProvider
        || availability.find(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0)?.provider;
      const providerAvailability = availability.find(item => item.provider === provider);
      const model = this.settings.realtimeVoiceModel && providerAvailability?.models?.some(candidate => candidate.id === this.settings.realtimeVoiceModel)
        ? this.settings.realtimeVoiceModel
        : providerAvailability?.models?.[0]?.id;

      return {
        provider,
        model,
        voice: this.settings.realtimeVoiceVoice,
        source: 'user'
      };
    };

    const updateVoiceOptions = (): void => {
      if (!voiceDropdown) return;
      const selection = getSelection();
      const model = getRealtimeVoiceModel(selection.provider, selection.model);
      const voices = model?.voices ?? [];

      voiceDropdown.empty();
      voiceDropdown.createEl('option', { value: '', text: 'Provider default' });
      voices.forEach(voice => {
        voiceDropdown?.createEl('option', { value: voice.id, text: voice.name });
      });

      if (selection.voice && !voices.some(voice => voice.id === selection.voice)) {
        voiceDropdown.createEl('option', {
          value: selection.voice,
          text: `${selection.voice} (unavailable)`
        });
      }

      voiceDropdown.disabled = !selection.provider || !selection.model;
      voiceDropdown.value = selection.voice || '';
    };

    const updateModelOptions = (): void => {
      if (!modelDropdown) return;
      const selection = getSelection();
      const availability = getAvailability();
      const providerAvailability = availability.find(item => item.provider === selection.provider);
      const providerUsable = providerAvailability?.enabled === true && providerAvailability.configured === true;
      const models = providerAvailability?.models ?? [];

      modelDropdown.empty();
      if (!selection.provider || models.length === 0) {
        modelDropdown.createEl('option', {
          value: '',
          text: 'Select a live voice provider first'
        });
        modelDropdown.disabled = true;
        updateVoiceOptions();
        return;
      }

      models.forEach(model => {
        modelDropdown?.createEl('option', { value: model.id, text: model.name });
      });

      if (selection.model && !models.some(model => model.id === selection.model)) {
        modelDropdown.createEl('option', {
          value: selection.model,
          text: `${selection.model} (unavailable)`
        });
      }

      const selectedModelExists = models.some(model => model.id === selection.model);
      const nextModel = selection.model && selectedModelExists
        ? selection.model
        : models[0]?.id || '';

      this.settings.realtimeVoiceProvider = selection.provider;
      this.settings.realtimeVoiceModel = nextModel || undefined;
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = nextModel;
      this.notifyChange();
      updateVoiceOptions();
    };

    new Setting(parent)
      .setName('Live voice provider')
      .setDesc('Only true realtime voice providers appear here.')
      .addDropdown(dropdown => {
        const availability = getAvailability();
        const selection = getSelection();
        const usableProviders = availability.filter(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0);

        if (usableProviders.length === 0 && !selection.provider) {
          dropdown.addOption('', 'No live voice providers available');
          dropdown.setDisabled(true);
          return;
        }

        usableProviders.forEach(provider => {
          dropdown.addOption(provider.provider, this.getProviderDisplayName(provider.provider));
        });

        if (selection.provider && !usableProviders.some(provider => provider.provider === selection.provider)) {
          dropdown.addOption(
            selection.provider,
            `${this.getProviderDisplayName(selection.provider)} (unavailable)`
          );
        }

        dropdown.setValue(selection.provider || usableProviders[0]?.provider || '');
        dropdown.onChange((provider) => {
          const providerAvailability = getAvailability().find(item => item.provider === provider);
          const model = providerAvailability?.models?.[0];
          this.settings.realtimeVoiceProvider = provider || undefined;
          this.settings.realtimeVoiceModel = model?.id;
          this.settings.realtimeVoiceVoice = model?.defaultVoice;
          this.notifyChange();
          updateModelOptions();
          onSelectionChange();
        });
      });

    new Setting(parent)
      .setName('Live voice model')
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        updateModelOptions();
        dropdown.onChange((modelId) => {
          const selection = getSelection();
          const model = getRealtimeVoiceModel(selection.provider, modelId);
          this.settings.realtimeVoiceModel = modelId || undefined;
          if (model) {
            this.settings.realtimeVoiceVoice = this.settings.realtimeVoiceVoice || model.defaultVoice;
          }
          this.notifyChange();
          updateVoiceOptions();
          onSelectionChange();
        });
      });

    new Setting(parent)
      .setName('Live voice')
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        updateVoiceOptions();
        dropdown.onChange((voice) => {
          this.settings.realtimeVoiceVoice = voice || undefined;
          this.notifyChange();
          onSelectionChange();
        });
      });
  }

  private getSpeechAppStates(): Partial<Record<SpeechProvider, { enabled: boolean; configured: boolean }>> {
    const elevenLabs = this.getAppsSettings()?.apps.elevenlabs;
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: !!elevenLabs.credentials.apiKey?.trim() } }
      : {};
  }

  private getRealtimeAppStates(): Partial<Record<'elevenlabs', { enabled: boolean; configured: boolean }>> {
    const elevenLabs = this.getAppsSettings()?.apps.elevenlabs;
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: !!elevenLabs.credentials.apiKey?.trim() } }
      : {};
  }

  private getVoiceWarningMessages(): string[] {
    const messages: string[] = [];
    const speechDefault = this.settings.speechProvider || this.settings.speechModel || this.settings.speechVoice
      ? {
        provider: this.settings.speechProvider,
        model: this.settings.speechModel,
        voice: this.settings.speechVoice,
        source: 'user' as const
      }
      : undefined;
    const realtimeDefault = this.settings.realtimeVoiceProvider || this.settings.realtimeVoiceModel || this.settings.realtimeVoiceVoice
      ? {
        provider: this.settings.realtimeVoiceProvider,
        model: this.settings.realtimeVoiceModel,
        voice: this.settings.realtimeVoiceVoice,
        source: 'user' as const
      }
      : undefined;
    const speechSelection = resolveDefaultSpeechSelection(
      {
        ...this.config.llmProviderSettings,
        defaultSpeechModel: speechDefault
      },
      buildSpeechProviderAvailability(this.config.llmProviderSettings, this.getSpeechAppStates())
    );
    const realtimeSelection = resolveDefaultRealtimeVoiceSelection(
      {
        ...this.config.llmProviderSettings,
        defaultRealtimeVoiceModel: realtimeDefault
      },
      buildRealtimeVoiceProviderAvailability(this.config.llmProviderSettings, this.getRealtimeAppStates())
    );

    if (speechSelection.status === 'invalid' && speechSelection.reason) {
      messages.push(speechSelection.reason);
    }

    if (realtimeSelection.status === 'invalid' && realtimeSelection.reason) {
      messages.push(realtimeSelection.reason);
    }

    return messages;
  }

  private getAppsSettings(): AppsSettings | undefined {
    const plugin = getNexusPlugin(this.config.app) as PluginWithAppSettings | null;
    return plugin?.settings?.settings?.apps;
  }

  private getProviderDisplayName(providerId: string): string {
    return ProviderUtils.getProviderDisplayName(providerId);
  }

  // ========== CONTEXT SECTION ==========

  private renderContextSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Context');
    const content = section.createDiv('csr-section-content');

    // Workspace
    new Setting(content)
      .setName('Workspace')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'None');

        this.config.options.workspaces.forEach(w => {
          dropdown.addOption(w.id, w.name);
        });

        dropdown.setValue(this.settings.workspaceId || '');
        dropdown.onChange((value) => {
          this.settings.workspaceId = value || null;
          this.notifyChange();
          void this.syncWorkspacePrompt(value);
        });
      });

    // Prompt
    new Setting(content)
      .setName('Prompt')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'None');

        this.config.options.prompts.forEach(p => {
          dropdown.addOption(p.id, p.name);
        });

        dropdown.setValue(this.settings.promptId || '');
        dropdown.onChange((value) => {
          this.settings.promptId = value || null;
          this.notifyChange();
        });
      });

    // Context Notes header with Add button
    const notesHeader = content.createDiv('csr-notes-header');
    notesHeader.createSpan().setText('Context notes');
    const addBtn = notesHeader.createEl('button', { cls: 'csr-add-btn' });
    addBtn.setText('Add');
    addBtn.onclick = () => this.openNotePicker();

    this.contextNotesListEl = content.createDiv('csr-notes-list');
    this.renderContextNotesList();
  }

  private syncWorkspacePrompt(workspaceId: string | null): void {
    if (!workspaceId) return;

    const workspace = this.config.options.workspaces.find(w => w.id === workspaceId);
    // dedicatedAgent field stored for backward compat, but contains prompt info
    if (workspace?.context?.dedicatedAgent?.agentId) {
      const promptId = workspace.context.dedicatedAgent.agentId;
      const prompt = this.config.options.prompts.find(p => p.id === promptId || p.name === promptId);
      if (prompt) {
        this.settings.promptId = prompt.id;
        this.notifyChange();
        this.render();
      }
    }
  }

  private renderContextNotesList(): void {
    const contextNotesListEl = this.contextNotesListEl;
    if (!contextNotesListEl) return;
    contextNotesListEl.empty();

    if (this.settings.contextNotes.length === 0) {
      contextNotesListEl.createDiv({ cls: 'csr-notes-empty', text: 'No files added' });
      return;
    }

    this.settings.contextNotes.forEach((notePath, index) => {
      const item = contextNotesListEl.createDiv('csr-note-item');
      item.createSpan({ cls: 'csr-note-path', text: notePath });
      const removeBtn = item.createEl('button', { cls: 'csr-note-remove', text: '×' });
      removeBtn.onclick = () => {
        this.settings.contextNotes.splice(index, 1);
        this.notifyChange();
        this.renderContextNotesList();
      };
    });
  }

  private async openNotePicker(): Promise<void> {
    const selectedPaths = await FilePickerRenderer.openModal(this.config.app, {
      title: 'Select Context Notes',
      excludePaths: this.settings.contextNotes
    });

    if (selectedPaths.length > 0) {
      this.settings.contextNotes.push(...selectedPaths);
      this.notifyChange();
      this.renderContextNotesList();
    }
  }

  // ========== HELPERS ==========

  private async getDefaultModelForProvider(providerId: string): Promise<string> {
    if (providerId === 'ollama') {
      return this.config.llmProviderSettings.providers.ollama?.ollamaModel || '';
    }

    try {
      const models = await this.providerManager.getModelsForProvider(providerId);
      return models[0]?.id || '';
    } catch {
      return '';
    }
  }

  getSettings(): ChatSettings {
    return { ...this.settings };
  }
}
