/**
 * ChatSettingsRenderer - Shared settings UI for DefaultsTab and ChatSettingsModal
 *
 * Renders identical UI in both places:
 * - Provider + Model (same section)
 * - Reasoning toggle + Effort slider
 * - Image generation settings
 * - Workspace + Agent
 * - Context notes
 *
 * The difference is only WHERE data is saved (via callbacks).
 */

import { App, Setting, EventRef } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';
import { LLMProviderSettings, ThinkingEffort } from '../../types/llm/ProviderTypes';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isDesktop, isProviderCompatible } from '../../utils/platform';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';

/**
 * Current settings state
 */
export interface ChatSettings {
  provider: string;
  model: string;
  // Agent Model - used for executePrompt when chat model is local
  agentProvider?: string;
  agentModel?: string;
  thinking: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  // Agent Model thinking settings (separate from chat model)
  agentThinking?: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  temperature: number; // 0.0-1.0, controls randomness
  imageProvider: 'google' | 'openrouter';
  imageModel: string;
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
}

const PROVIDER_NAMES: Record<string, string> = {
  webllm: 'Nexus (Local)',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  mistral: 'Mistral AI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  requesty: 'Requesty',
  perplexity: 'Perplexity',
  'openai-codex': 'ChatGPT'
};

const EFFORT_LEVELS: ThinkingEffort[] = ['low', 'medium', 'high'];
const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
};

const IMAGE_MODELS: Record<string, Array<{ id: string; name: string }>> = {
  google: [
    { id: 'gemini-2.5-flash-image', name: 'Nano Banana (Fast)' },
    { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro (Advanced)' }
  ],
  openrouter: [
    { id: 'gemini-2.5-flash-image', name: 'Nano Banana (Fast)' },
    { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro (Advanced)' },
    { id: 'flux-2-pro', name: 'FLUX.2 Pro' },
    { id: 'flux-2-flex', name: 'FLUX.2 Flex' }
  ]
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

  constructor(container: HTMLElement, config: ChatSettingsRendererConfig) {
    this.container = container;
    this.config = config;
    this.settings = { ...config.initialSettings };
    this.staticModelsService = StaticModelsService.getInstance();

    this.providerManager = new LLMProviderManager(
      config.llmProviderSettings,
      config.app.vault
    );

    this.settingsEventRef = LLMSettingsNotifier.onSettingsChanged((newSettings) => {
      this.config.llmProviderSettings = newSettings;
      this.providerManager.updateSettings(newSettings);
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

    // Vertical layout - order: Chat (with Reasoning), Agent, Image, Temp, Context
    this.renderModelSection(this.container);
    this.renderAgentModelSection(this.container);
    this.renderImageSection(this.container);
    this.renderTemperatureSection(this.container);
    this.renderContextSection(this.container);
  }

  private notifyChange(): void {
    this.config.callbacks.onSettingsChange({ ...this.settings });
  }

  private getEnabledProviders(): string[] {
    const llmSettings = this.config.llmProviderSettings;
    return Object.keys(llmSettings.providers).filter(id => {
      // Codex models are merged into the OpenAI provider display
      if (id === 'openai-codex') return false;
      const config = llmSettings.providers[id];
      if (!config?.enabled) return false;
      if (!isProviderCompatible(id)) return false;
      // WebLLM doesn't need an API key
      if (id === 'webllm') return true;
      // Local providers store the server URL in apiKey
      return !!config.apiKey;
    });
  }

  private isCodexConnected(): boolean {
    const codexConfig = this.config.llmProviderSettings.providers['openai-codex'];
    return !!(codexConfig?.oauth?.connected && codexConfig?.apiKey);
  }

  // ========== MODEL SECTION ==========

  private renderModelSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Chat Model');
    const content = section.createDiv('csr-section-content');

    // Provider
    new Setting(content)
      .setName('Provider')
      .addDropdown(dropdown => {
        const providers = this.getEnabledProviders();
        // openai-codex is displayed under openai in the dropdown
        const displayProvider = this.settings.provider === 'openai-codex' ? 'openai' : this.settings.provider;

        // If the currently-selected provider isn't usable on this platform (e.g. desktop-only
        // providers on mobile), fall back to the first available option.
        if (providers.length > 0 && !providers.includes(displayProvider)) {
          const nextProvider = providers[0];
          this.settings.provider = nextProvider;
          this.settings.model = '';
          void this.getDefaultModelForProvider(nextProvider).then((modelId) => {
            // Avoid stomping if user changed provider during async load
            if (this.settings.provider !== nextProvider) return;
            this.settings.model = modelId;
            this.notifyChange();
            this.render();
          });
        }

        if (providers.length === 0) {
          dropdown.addOption('', 'No providers enabled');
        } else {
          providers.forEach(id => {
            dropdown.addOption(id, PROVIDER_NAMES[id] || id);
          });
        }

        dropdown.setValue(displayProvider);
        dropdown.onChange(async (value) => {
          this.settings.provider = value;
          this.settings.model = await this.getDefaultModelForProvider(value);
          this.notifyChange();
          this.render();
        });
      });

    // Model
    const providerId = this.settings.provider;
    // For display purposes, openai-codex models appear under openai
    const modelProviderId = providerId === 'openai-codex' ? 'openai' : providerId;

    if (modelProviderId === 'ollama') {
      new Setting(content)
        .setName('Model')
        .addText(text => text
          .setValue(this.settings.model || '')
          .setDisabled(true)
          .setPlaceholder('Configure in Ollama settings'));
    } else {
      new Setting(content)
        .setName('Model')
        .addDropdown(async dropdown => {
          if (!modelProviderId) {
            dropdown.addOption('', 'Select a provider first');
            return;
          }

          try {
            this.modelOptionMap.clear();
            let models = await this.providerManager.getModelsForProvider(modelProviderId);

            // Merge Codex models into OpenAI list when Codex OAuth is connected
            if (modelProviderId === 'openai' && this.isCodexConnected()) {
              const codexModels = await this.providerManager.getModelsForProvider('openai-codex');
              const openaiModelIds = new Set(models.map(m => m.id));
              for (const cm of codexModels) {
                // Skip duplicates (same model ID available in both providers)
                if (!openaiModelIds.has(cm.id)) {
                  models = [...models, { ...cm, name: `${cm.name} (ChatGPT)` }];
                }
              }
            }

            if (models.length === 0) {
              dropdown.addOption('', 'No models available');
            } else {
              models.forEach(model => {
                const optionKey = model.id;
                this.modelOptionMap.set(optionKey, { provider: model.provider, modelId: model.id });
                dropdown.addOption(optionKey, model.name);
              });

              const exists = models.some(m => m.id === this.settings.model);
              if (exists) {
                dropdown.setValue(this.settings.model);
              } else if (models.length > 0) {
                const firstEntry = this.modelOptionMap.get(models[0].id);
                this.settings.model = models[0].id;
                if (firstEntry) this.settings.provider = firstEntry.provider;
                dropdown.setValue(this.settings.model);
              }
            }

            dropdown.onChange((value) => {
              const entry = this.modelOptionMap.get(value);
              this.settings.model = entry?.modelId ?? value;
              this.settings.provider = entry?.provider ?? modelProviderId;
              this.notifyChange();
              // Re-render to update reasoning visibility
              this.render();
            });
          } catch {
            dropdown.addOption('', 'Error loading models');
          }
        });
    }

    // Reasoning controls (only if model supports thinking)
    this.renderReasoningControls(content);
  }

  /**
   * Render reasoning controls inside a section (not as separate section)
   */
  private renderReasoningControls(content: HTMLElement): void {
    const supportsThinking = this.checkModelSupportsThinking();
    if (!supportsThinking) return;

    // Reasoning toggle
    new Setting(content)
      .setName('Reasoning')
      .setDesc('Think step-by-step')
      .addToggle(toggle => toggle
        .setValue(this.settings.thinking.enabled)
        .onChange(value => {
          this.settings.thinking.enabled = value;
          this.notifyChange();
          this.updateEffortVisibility();
        }));

    // Effort slider
    this.effortSection = content.createDiv('csr-effort-row');
    if (!this.settings.thinking.enabled) {
      this.effortSection.addClass('is-hidden');
    }

    const effortSetting = new Setting(this.effortSection)
      .setName('Effort');

    const valueDisplay = effortSetting.controlEl.createSpan({ cls: 'csr-effort-value' });
    valueDisplay.setText(EFFORT_LABELS[this.settings.thinking.effort]);

    effortSetting.addSlider(slider => {
      slider
        .setLimits(0, 2, 1)
        .setValue(EFFORT_LEVELS.indexOf(this.settings.thinking.effort))
        .onChange((value: number) => {
          this.settings.thinking.effort = EFFORT_LEVELS[value];
          valueDisplay.setText(EFFORT_LABELS[this.settings.thinking.effort]);
          this.notifyChange();
        });
      return slider;
    });
  }

  // ========== AGENT MODEL SECTION ==========

  /**
   * Render Agent Model section - always shown, excludes local providers.
   * This model is used for executePrompt and other API-dependent operations.
   */
  private renderAgentModelSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Agent Model');
    const desc = section.createDiv('csr-section-desc');
    const descText = desc.createSpan();
    descText.setText('Cloud model for AI actions');
    const infoIcon = desc.createSpan({ cls: 'csr-info-icon' });
    infoIcon.setText(' ⓘ');
    infoIcon.setAttribute('aria-label', 'Saved prompts and automations require a cloud API.');
    infoIcon.addClass('clickable-icon');
    const content = section.createDiv('csr-section-content');

    // Get only API-based providers (exclude local ones)
    const apiProviders = this.getEnabledProviders().filter(id => !LOCAL_PROVIDERS.includes(id));
    const agentDisplayProvider = this.settings.agentProvider === 'openai-codex' ? 'openai' : this.settings.agentProvider;

    // Provider dropdown
    new Setting(content)
      .setName('Provider')
      .addDropdown(dropdown => {
        // If the currently-selected agent provider isn't available, fall back to first API provider
        if (apiProviders.length > 0 && agentDisplayProvider && !apiProviders.includes(agentDisplayProvider)) {
          const nextProvider = apiProviders[0];
          this.settings.agentProvider = nextProvider;
          this.settings.agentModel = '';
          void this.getDefaultModelForProvider(nextProvider).then((modelId) => {
            if (this.settings.agentProvider !== nextProvider) return;
            this.settings.agentModel = modelId;
            this.notifyChange();
            this.render();
          });
        }

        if (apiProviders.length === 0) {
          dropdown.addOption('', 'No cloud providers enabled');
        } else {
          apiProviders.forEach(id => {
            dropdown.addOption(id, PROVIDER_NAMES[id] || id);
          });
        }

        dropdown.setValue(agentDisplayProvider || '');
        dropdown.onChange(async (value) => {
          this.settings.agentProvider = value === '' ? undefined : value;
          this.settings.agentModel = value ? await this.getDefaultModelForProvider(value) : undefined;
          this.notifyChange();
          this.render();
        });
      });

    // Model dropdown - always shown (mirrors Chat Model pattern)
    const agentProviderId = this.settings.agentProvider;
    const agentModelProviderId = agentProviderId === 'openai-codex' ? 'openai' : agentProviderId;

    new Setting(content)
      .setName('Model')
      .addDropdown(async dropdown => {
        if (!agentModelProviderId) {
          dropdown.addOption('', 'Select a provider first');
          return;
        }

        try {
          this.agentModelOptionMap.clear();
          let models = await this.providerManager.getModelsForProvider(agentModelProviderId);

          // Merge Codex models into OpenAI list when Codex OAuth is connected
          if (agentModelProviderId === 'openai' && this.isCodexConnected()) {
            const codexModels = await this.providerManager.getModelsForProvider('openai-codex');
            const openaiModelIds = new Set(models.map(m => m.id));
            for (const cm of codexModels) {
              if (!openaiModelIds.has(cm.id)) {
                models = [...models, { ...cm, name: `${cm.name} (ChatGPT)` }];
              }
            }
          }

          if (models.length === 0) {
            dropdown.addOption('', 'No models available');
          } else {
            models.forEach(model => {
              const optionKey = model.id;
              this.agentModelOptionMap.set(optionKey, { provider: model.provider, modelId: model.id });
              dropdown.addOption(optionKey, model.name);
            });

            const exists = models.some(m => m.id === this.settings.agentModel);
            if (exists) {
              dropdown.setValue(this.settings.agentModel!);
            } else if (models.length > 0) {
              const firstEntry = this.agentModelOptionMap.get(models[0].id);
              this.settings.agentModel = models[0].id;
              if (firstEntry) this.settings.agentProvider = firstEntry.provider;
              dropdown.setValue(this.settings.agentModel);
            }
          }

          dropdown.onChange((value) => {
            const entry = this.agentModelOptionMap.get(value);
            this.settings.agentModel = entry?.modelId ?? value;
            this.settings.agentProvider = entry?.provider ?? agentModelProviderId;
            this.notifyChange();
            // Re-render to update reasoning visibility
            this.render();
          });
        } catch {
          dropdown.addOption('', 'Error loading models');
        }
      });

    // Agent Reasoning controls (only if agent model supports thinking)
    this.renderAgentReasoningControls(content);
  }

  /**
   * Render agent reasoning controls inside Agent Model section
   */
  private renderAgentReasoningControls(content: HTMLElement): void {
    const supportsThinking = this.checkAgentModelSupportsThinking();
    if (!supportsThinking) return;

    // Initialize agent thinking if not set
    if (!this.settings.agentThinking) {
      this.settings.agentThinking = { enabled: false, effort: 'medium' };
    }

    // Reasoning toggle
    new Setting(content)
      .setName('Reasoning')
      .setDesc('Think step-by-step')
      .addToggle(toggle => toggle
        .setValue(this.settings.agentThinking?.enabled ?? false)
        .onChange(value => {
          if (!this.settings.agentThinking) {
            this.settings.agentThinking = { enabled: false, effort: 'medium' };
          }
          this.settings.agentThinking.enabled = value;
          this.notifyChange();
          this.updateAgentEffortVisibility();
        }));

    // Effort slider
    this.agentEffortSection = content.createDiv('csr-effort-row');
    if (!this.settings.agentThinking?.enabled) {
      this.agentEffortSection.addClass('is-hidden');
    }

    const effortSetting = new Setting(this.agentEffortSection)
      .setName('Effort');

    const valueDisplay = effortSetting.controlEl.createSpan({ cls: 'csr-effort-value' });
    valueDisplay.setText(EFFORT_LABELS[this.settings.agentThinking?.effort ?? 'medium']);

    effortSetting.addSlider(slider => {
      slider
        .setLimits(0, 2, 1)
        .setValue(EFFORT_LEVELS.indexOf(this.settings.agentThinking?.effort ?? 'medium'))
        .onChange((value: number) => {
          if (!this.settings.agentThinking) {
            this.settings.agentThinking = { enabled: false, effort: 'medium' };
          }
          this.settings.agentThinking.effort = EFFORT_LEVELS[value];
          valueDisplay.setText(EFFORT_LABELS[this.settings.agentThinking.effort]);
          this.notifyChange();
        });
      return slider;
    });
  }

  /**
   * Check if agent model supports thinking
   */
  private checkAgentModelSupportsThinking(): boolean {
    if (!this.settings.agentProvider || !this.settings.agentModel) return false;

    const model = this.staticModelsService.findModel(this.settings.agentProvider, this.settings.agentModel);
    return model?.capabilities?.supportsThinking ?? false;
  }

  /**
   * Update agent effort slider visibility
   */
  private updateAgentEffortVisibility(): void {
    if (!this.agentEffortSection) return;

    if (this.settings.agentThinking?.enabled) {
      this.agentEffortSection.removeClass('is-hidden');
    } else {
      this.agentEffortSection.addClass('is-hidden');
    }
  }

  // ========== TEMPERATURE SECTION ==========

  private renderTemperatureSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Temperature');
    const content = section.createDiv('csr-section-content');

    // Create container for slider row with value display
    const tempSetting = new Setting(content)
      .setName('Creativity')
      .setDesc('Lower = more focused, Higher = more creative');

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

  private updateEffortVisibility(): void {
    if (!this.effortSection) return;

    if (this.settings.thinking.enabled) {
      this.effortSection.removeClass('is-hidden');
    } else {
      this.effortSection.addClass('is-hidden');
    }
  }

  // ========== IMAGE SECTION ==========

  private renderImageSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Image Model');
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
          this.settings.imageModel = IMAGE_MODELS[this.settings.imageProvider]?.[0]?.id || '';
          this.notifyChange();
        }

        providers.forEach(p => dropdown.addOption(p.id, p.name));

        dropdown.setValue(this.settings.imageProvider);
        dropdown.onChange((value) => {
          this.settings.imageProvider = value as 'google' | 'openrouter';
          this.settings.imageModel = IMAGE_MODELS[value]?.[0]?.id || '';
          this.notifyChange();
          this.render();
        });
      });

    // Model
    const models = IMAGE_MODELS[this.settings.imageProvider] || [];
    new Setting(content)
      .setName('Model')
      .addDropdown(dropdown => {
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

        dropdown.onChange((value) => {
          this.settings.imageModel = value;
          this.notifyChange();
        });
      });
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
          this.syncWorkspacePrompt(value);
        });
      });

    // Prompt
    new Setting(content)
      .setName('Prompt')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'None');

        this.config.options.prompts.forEach(p => {
          dropdown.addOption(p.name, p.name);
        });

        dropdown.setValue(this.settings.promptId || '');
        dropdown.onChange((value) => {
          this.settings.promptId = value || null;
          this.notifyChange();
        });
      });

    // Context Notes header with Add button
    const notesHeader = content.createDiv('csr-notes-header');
    notesHeader.createSpan().setText('Context Notes');
    const addBtn = notesHeader.createEl('button', { cls: 'csr-add-btn' });
    addBtn.setText('+ Add');
    addBtn.onclick = () => this.openNotePicker();

    this.contextNotesListEl = content.createDiv('csr-notes-list');
    this.renderContextNotesList();
  }

  private async syncWorkspacePrompt(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return;

    const workspace = this.config.options.workspaces.find(w => w.id === workspaceId);
    // dedicatedAgent field stored for backward compat, but contains prompt info
    if (workspace?.context?.dedicatedAgent?.agentId) {
      const promptId = workspace.context.dedicatedAgent.agentId;
      const prompt = this.config.options.prompts.find(p => p.id === promptId || p.name === promptId);
      if (prompt) {
        this.settings.promptId = prompt.name;
        this.notifyChange();
        this.render();
      }
    }
  }

  private renderContextNotesList(): void {
    if (!this.contextNotesListEl) return;
    this.contextNotesListEl.empty();

    if (this.settings.contextNotes.length === 0) {
      this.contextNotesListEl.createDiv({ cls: 'csr-notes-empty', text: 'No files added' });
      return;
    }

    this.settings.contextNotes.forEach((notePath, index) => {
      const item = this.contextNotesListEl!.createDiv('csr-note-item');
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

  private checkModelSupportsThinking(): boolean {
    if (!this.settings.provider || !this.settings.model) return false;

    const model = this.staticModelsService.findModel(this.settings.provider, this.settings.model);
    return model?.capabilities?.supportsThinking ?? false;
  }

  getSettings(): ChatSettings {
    return { ...this.settings };
  }
}
