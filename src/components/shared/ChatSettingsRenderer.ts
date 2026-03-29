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
import { ImageGenerationService } from '../../services/llm/ImageGenerationService';
import { LLMProviderSettings, ThinkingEffort } from '../../types/llm/ProviderTypes';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isDesktop, isProviderCompatible } from '../../utils/platform';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { renderModelDropdownSection } from './ModelDropdownRenderer';

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
      sectionTitle: 'Chat Model',
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
      onAfterRender: (content) => this.renderReasoningControls(content),
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

    const getThinking = () => isAgent ? this.settings.agentThinking! : this.settings.thinking;

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

  // ========== AGENT MODEL SECTION ==========

  /**
   * Render Agent Model section - always shown, excludes local providers.
   * This model is used for executePrompt and other API-dependent operations.
   */
  private renderAgentModelSection(parent: HTMLElement): void {
    renderModelDropdownSection(parent, {
      sectionTitle: 'Agent Model',
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
      onAfterRender: (content) => this.renderReasoningControls(content, 'agent'),
    });
  }

  // ========== TEMPERATURE SECTION ==========

  private renderTemperatureSection(parent: HTMLElement): void {
    const section = parent.createDiv('csr-section');
    section.createDiv('csr-section-header').setText('Temperature');
    const content = section.createDiv('csr-section-content');

    // Create container for slider row with value display
    const tempSetting = new Setting(content)
      .setName('Creativity')
      .setDesc('Lower = more focused, higher = more creative');

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

        providers.forEach(p => {
          dropdown.addOption(p.id, p.name);
        });

        dropdown.setValue(this.settings.imageProvider);
        dropdown.onChange((value) => {
          void (async () => {
            this.settings.imageProvider = value as 'google' | 'openrouter';
            const models = await this.imageService.getModelsForProvider(value as 'google' | 'openrouter');
            this.settings.imageModel = models[0]?.id || '';
            this.notifyChange();
            this.render();
          })();
        });
      });

    // Model (async — populate from adapter)
    new Setting(content)
      .setName('Model')
      .addDropdown(dropdown => {
        void (async () => {
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
        })();
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

  private async syncWorkspacePrompt(workspaceId: string | null): Promise<void> {
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

  getSettings(): ChatSettings {
    return { ...this.settings };
  }
}
