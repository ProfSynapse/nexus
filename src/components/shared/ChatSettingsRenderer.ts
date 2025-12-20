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

import { App, Setting } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';
import { LLMProviderSettings, ThinkingEffort } from '../../types/llm/ProviderTypes';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isDesktop, isProviderCompatible } from '../../utils/platform';

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
  imageProvider: 'google' | 'openrouter';
  imageModel: string;
  workspaceId: string | null;
  agentId: string | null;
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
  agents: Array<{ id: string; name: string }>;
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
  perplexity: 'Perplexity'
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
  private contextNotesListEl?: HTMLElement;

  constructor(container: HTMLElement, config: ChatSettingsRendererConfig) {
    this.container = container;
    this.config = config;
    this.settings = { ...config.initialSettings };
    this.staticModelsService = StaticModelsService.getInstance();

    this.providerManager = new LLMProviderManager(
      config.llmProviderSettings,
      config.app.vault
    );
  }

  render(): void {
    this.container.empty();
    this.container.addClass('chat-settings-renderer');

    // Vertical layout
    this.renderModelSection(this.container);
    this.renderAgentModelSection(this.container);
    this.renderReasoningSection(this.container);
    this.renderImageSection(this.container);
    this.renderContextSection(this.container);
  }

  private notifyChange(): void {
    this.config.callbacks.onSettingsChange({ ...this.settings });
  }

  private getEnabledProviders(): string[] {
    const llmSettings = this.config.llmProviderSettings;
    return Object.keys(llmSettings.providers).filter(id => {
      const config = llmSettings.providers[id];
      if (!config?.enabled) return false;
      if (!isProviderCompatible(id)) return false;
      // WebLLM doesn't need an API key
      if (id === 'webllm') return true;
      // Local providers store the server URL in apiKey
      return !!config.apiKey;
    });
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

        // If the currently-selected provider isn't usable on this platform (e.g. desktop-only
        // providers on mobile), fall back to the first available option.
        if (providers.length > 0 && !providers.includes(this.settings.provider)) {
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

        dropdown.setValue(this.settings.provider);
        dropdown.onChange(async (value) => {
          this.settings.provider = value;
          this.settings.model = await this.getDefaultModelForProvider(value);
          this.notifyChange();
          this.render();
        });
      });

    // Model
    const providerId = this.settings.provider;

    if (providerId === 'ollama') {
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
          if (!providerId) {
            dropdown.addOption('', 'Select a provider first');
            return;
          }

          try {
            const models = await this.providerManager.getModelsForProvider(providerId);

            if (models.length === 0) {
              dropdown.addOption('', 'No models available');
            } else {
              models.forEach(model => {
                dropdown.addOption(model.id, model.name);
              });

              const exists = models.some(m => m.id === this.settings.model);
              if (exists) {
                dropdown.setValue(this.settings.model);
              } else if (models.length > 0) {
                this.settings.model = models[0].id;
                dropdown.setValue(this.settings.model);
                this.notifyChange();
              }
            }

            dropdown.onChange((value) => {
              this.settings.model = value;
              this.notifyChange();
              // Re-render to update reasoning visibility
              this.render();
            });
          } catch {
            dropdown.addOption('', 'Error loading models');
          }
        });
    }
  }

  // ========== AGENT MODEL SECTION ==========

  /**
   * Render Agent Model section - only shown when chat model is a local provider.
   * This model is used for executePrompt and other API-dependent operations.
   */
  private renderAgentModelSection(parent: HTMLElement): void {
    // Only show when chat model is a local provider
    const isLocalProvider = LOCAL_PROVIDERS.includes(this.settings.provider);
    if (!isLocalProvider) return;

    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Agent Model');
    const desc = section.createDiv('csr-section-desc');
    desc.setText('Used for executePrompt when chat uses a local model');
    const content = section.createDiv('csr-section-content');

    // Get only API-based providers (exclude local ones)
    const apiProviders = this.getEnabledProviders().filter(id => !LOCAL_PROVIDERS.includes(id));

    // Provider dropdown
    new Setting(content)
      .setName('Provider')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'Auto (first available)');

        if (apiProviders.length === 0) {
          // No API providers available - show warning
          dropdown.addOption('', 'No API providers enabled');
        } else {
          apiProviders.forEach(id => {
            dropdown.addOption(id, PROVIDER_NAMES[id] || id);
          });
        }

        dropdown.setValue(this.settings.agentProvider || '');
        dropdown.onChange(async (value) => {
          this.settings.agentProvider = value || undefined;
          if (value) {
            this.settings.agentModel = await this.getDefaultModelForProvider(value);
          } else {
            this.settings.agentModel = undefined;
          }
          this.notifyChange();
          this.render();
        });
      });

    // Model dropdown - only if a provider is selected
    if (this.settings.agentProvider && apiProviders.includes(this.settings.agentProvider)) {
      new Setting(content)
        .setName('Model')
        .addDropdown(async dropdown => {
          try {
            const models = await this.providerManager.getModelsForProvider(this.settings.agentProvider!);

            if (models.length === 0) {
              dropdown.addOption('', 'No models available');
            } else {
              models.forEach(model => {
                dropdown.addOption(model.id, model.name);
              });

              const exists = models.some(m => m.id === this.settings.agentModel);
              if (exists) {
                dropdown.setValue(this.settings.agentModel!);
              } else if (models.length > 0) {
                this.settings.agentModel = models[0].id;
                dropdown.setValue(this.settings.agentModel);
                this.notifyChange();
              }
            }

            dropdown.onChange((value) => {
              this.settings.agentModel = value;
              this.notifyChange();
            });
          } catch {
            dropdown.addOption('', 'Error loading models');
          }
        });
    }
  }

  // ========== REASONING SECTION ==========

  private renderReasoningSection(parent: HTMLElement): void {
    const supportsThinking = this.checkModelSupportsThinking();
    if (!supportsThinking) return;

    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Reasoning');
    const content = section.createDiv('csr-section-content');

    // Reasoning toggle
    new Setting(content)
      .setName('Enable')
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

    const valueDisplay = effortSetting.controlEl.createSpan('csr-effort-value');
    valueDisplay.textContent = EFFORT_LABELS[this.settings.thinking.effort];

    effortSetting.addSlider(slider => slider
      .setLimits(0, 2, 1)
      .setValue(EFFORT_LEVELS.indexOf(this.settings.thinking.effort))
      .onChange(value => {
        this.settings.thinking.effort = EFFORT_LEVELS[value];
        valueDisplay.textContent = EFFORT_LABELS[this.settings.thinking.effort];
        this.notifyChange();
      }));
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
    section.createDiv('csr-section-header').setText('Image Generation');
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
          this.syncWorkspaceAgent(value);
        });
      });

    // Agent
    new Setting(content)
      .setName('Agent')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'None');

        this.config.options.agents.forEach(a => {
          dropdown.addOption(a.name, a.name);
        });

        dropdown.setValue(this.settings.agentId || '');
        dropdown.onChange((value) => {
          this.settings.agentId = value || null;
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

  private async syncWorkspaceAgent(workspaceId: string | null): Promise<void> {
    if (!workspaceId) return;

    const workspace = this.config.options.workspaces.find(w => w.id === workspaceId);
    if (workspace?.context?.dedicatedAgent?.agentId) {
      const agentId = workspace.context.dedicatedAgent.agentId;
      const agent = this.config.options.agents.find(a => a.id === agentId || a.name === agentId);
      if (agent) {
        this.settings.agentId = agent.name;
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
