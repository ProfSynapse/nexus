/**
 * DefaultsTab - Default settings for new chats
 *
 * Uses ChatSettingsRenderer for identical UI to ChatSettingsModal.
 * Saves to plugin settings (defaults for all new chats).
 */

import { App, Notice, Platform, Setting } from 'obsidian';
import {
  DefaultRealtimeVoiceModelSettings,
  DefaultSpeechModelSettings,
  LLMProviderSettings
} from '../../types/llm/ProviderTypes';
import { Settings } from '../../settings';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { ChatSettingsRenderer, ChatSettings } from '../../components/shared/ChatSettingsRenderer';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import {
  getIngestCapabilityOptions,
  normalizeIngestSelection,
} from '../../agents/ingestManager/tools/services/IngestCapabilityService';
import { renderIngestModelDropdowns } from '../../components/shared/IngestModelDropdownRenderer';
import { AppManager } from '../../services/apps/AppManager';
import { ProviderUtils } from '../../ui/chat/utils/ProviderUtils';
import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  resolveDefaultSpeechSelection,
  SpeechAppCapabilityStates,
  SpeechModelDeclaration,
  SpeechProviderAvailability,
} from '../../services/llm/types/SpeechTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  RealtimeAppCapabilityStates,
  RealtimeVoiceModelDeclaration,
  RealtimeVoiceProviderAvailability,
  resolveDefaultRealtimeVoiceSelection,
} from '../../services/llm/types/RealtimeVoiceTypes';

export interface DefaultsTabServices {
  app: App;
  settings: Settings;
  llmProviderSettings?: LLMProviderSettings;
  workspaceService?: WorkspaceService;
  customPromptStorage?: CustomPromptStorageService;
  appManager?: AppManager;
}

export class DefaultsTab {
  private container: HTMLElement;
  private services: DefaultsTabServices;
  private renderer: ChatSettingsRenderer | null = null;

  constructor(
    container: HTMLElement,
    services: DefaultsTabServices
  ) {
    this.container = container;
    this.services = services;

    void this.loadDataAndRender();
  }

  /**
   * Load workspaces and prompts, then render
   */
  private async loadDataAndRender(): Promise<void> {
    const workspaces = await this.loadWorkspaces();
    const prompts = this.loadPrompts();

    await this.render(workspaces, prompts);
  }

  private async loadWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    if (!this.services.workspaceService) return [];

    try {
      const workspaces = await this.services.workspaceService.getAllWorkspaces();
      return workspaces.map(w => ({ id: w.id, name: w.name }));
    } catch {
      return [];
    }
  }

  private loadPrompts(): Array<{ id: string; name: string }> {
    if (!this.services.customPromptStorage) return [];

    try {
      const prompts = this.services.customPromptStorage.getAllPrompts();
      return prompts.map(p => ({ id: p.name, name: p.name }));
    } catch {
      return [];
    }
  }

  /**
   * Get current defaults from settings
   */
  private getCurrentSettings(): ChatSettings {
    const llmSettings = this.services.llmProviderSettings;
    const pluginSettings = this.services.settings.settings;

    const result = {
      provider: llmSettings?.defaultModel?.provider || '',
      model: llmSettings?.defaultModel?.model || '',
      agentProvider: llmSettings?.agentModel?.provider || undefined,
      agentModel: llmSettings?.agentModel?.model || undefined,
      thinking: {
        enabled: llmSettings?.defaultThinking?.enabled ?? false,
        effort: llmSettings?.defaultThinking?.effort ?? 'medium'
      },
      agentThinking: llmSettings?.agentThinking ? {
        enabled: llmSettings.agentThinking.enabled ?? false,
        effort: llmSettings.agentThinking.effort ?? 'medium'
      } : undefined,
      temperature: llmSettings?.defaultTemperature ?? 0.5,
      imageProvider: llmSettings?.defaultImageModel?.provider || 'google',
      imageModel: llmSettings?.defaultImageModel?.model || 'gemini-2.5-flash-image',
      transcriptionProvider: llmSettings?.defaultTranscriptionModel?.provider,
      transcriptionModel: llmSettings?.defaultTranscriptionModel?.model,
      workspaceId: pluginSettings.defaultWorkspaceId || null,
      promptId: pluginSettings.defaultPromptId || null,
      contextNotes: pluginSettings.defaultContextNotes || []
    };
    return result;
  }

  /**
   * Save settings to plugin
   */
  private async saveSettings(settings: ChatSettings): Promise<void> {
    const llmSettings = this.services.llmProviderSettings;
    const pluginSettings = this.services.settings.settings;

    if (llmSettings) {
      llmSettings.defaultModel = {
        provider: settings.provider,
        model: settings.model
      };
      // Save agent model (for executePrompt when using local chat model)
      if (settings.agentProvider) {
        llmSettings.agentModel = {
          provider: settings.agentProvider,
          model: settings.agentModel || ''
        };
      } else {
        llmSettings.agentModel = undefined;
      }
      llmSettings.defaultThinking = {
        enabled: settings.thinking.enabled,
        effort: settings.thinking.effort
      };
      // Save agent thinking settings
      if (settings.agentThinking) {
        llmSettings.agentThinking = {
          enabled: settings.agentThinking.enabled,
          effort: settings.agentThinking.effort
        };
      } else {
        llmSettings.agentThinking = undefined;
      }
      llmSettings.defaultTemperature = settings.temperature;
      llmSettings.defaultImageModel = {
        provider: settings.imageProvider,
        model: settings.imageModel
      };
      llmSettings.defaultTranscriptionModel = settings.transcriptionProvider && settings.transcriptionModel
        ? {
          provider: settings.transcriptionProvider,
          model: settings.transcriptionModel
        }
        : undefined;
      pluginSettings.llmProviders = llmSettings;
    }

    pluginSettings.defaultWorkspaceId = settings.workspaceId || undefined;
    pluginSettings.defaultPromptId = settings.promptId || undefined;
    pluginSettings.defaultContextNotes = settings.contextNotes;

    await this.services.settings.saveSettings();
  }

  /**
   * Main render method
   */
  private async render(
    workspaces: Array<{ id: string; name: string }>,
    prompts: Array<{ id: string; name: string }>
  ): Promise<void> {
    this.container.empty();

    if (!this.services.llmProviderSettings) {
      this.container.createEl('p', { text: 'Settings not available' });
      return;
    }

    // Header
    this.container.createEl('h2', { text: 'Defaults' });
    this.container.createEl('p', {
      text: 'These settings are used when starting a new chat.',
      cls: 'setting-item-description'
    });

    // Shared renderer
    const rendererContainer = this.container.createDiv('defaults-renderer');

    this.renderer = new ChatSettingsRenderer(rendererContainer, {
      app: this.services.app,
      llmProviderSettings: this.services.llmProviderSettings,
      initialSettings: this.getCurrentSettings(),
      options: { workspaces, prompts },
      showTranscriptionSection: false,
      renderAfterImageSection: (parent) => {
        void this.renderVoiceSection(parent);
      },
      callbacks: {
        onSettingsChange: (settings) => {
          void this.saveSettings(settings);
        }
      }
    });

    this.renderer.render();

    await this.renderIngestionSection(rendererContainer);

    // Embeddings section (desktop only)
    if (!Platform.isMobile) {
      const embeddingsSection = createDiv({ cls: 'csr-section' });
      const embeddingsHeader = embeddingsSection.createDiv({ cls: 'csr-section-header' });
      embeddingsHeader.setText('Embeddings');
      const embeddingsContent = embeddingsSection.createDiv({ cls: 'csr-section-content' });

      new Setting(embeddingsContent)
        .setName('Enable')
        .setDesc('Local embeddings for semantic search (~23 megabytes download). Restart to apply.')
        .addToggle(toggle => {
          toggle
            .setValue(this.services.settings.settings.enableEmbeddings ?? true)
            .onChange(async (value) => {
              this.services.settings.settings.enableEmbeddings = value;
              await this.services.settings.saveSettings();
              new Notice(`Embeddings ${value ? 'enabled' : 'disabled'}. Restart Obsidian to apply.`);
            });
        });

      rendererContainer.appendChild(embeddingsSection);
    }
  }

  /**
   * Render voice defaults: transcription, read-aloud speech, and realtime live voice.
   */
  private async renderVoiceSection(parentEl: HTMLElement): Promise<void> {
    const llmSettings = this.services.llmProviderSettings;
    if (!llmSettings) return;

    const section = createDiv({ cls: 'csr-section nexus-voice-section' });
    const header = section.createDiv({ cls: 'csr-section-header' });
    header.setText('Voice');
    const content = section.createDiv({ cls: 'csr-section-content' });
    content.createDiv({
      cls: 'setting-item-description',
      text: 'Loading voice models...'
    });
    parentEl.appendChild(section);

    const providerManager = new LLMProviderManager(llmSettings, this.services.app.vault);
    const capabilities = await getIngestCapabilityOptions(providerManager).catch(() => undefined);

    if (capabilities) {
      const normalizedTranscriptionSelection = normalizeIngestSelection(
        capabilities.transcriptionProviders,
        llmSettings.defaultTranscriptionModel?.provider,
        llmSettings.defaultTranscriptionModel?.model
      );

      if (normalizedTranscriptionSelection.provider && normalizedTranscriptionSelection.model) {
        llmSettings.defaultTranscriptionModel = {
          provider: normalizedTranscriptionSelection.provider,
          model: normalizedTranscriptionSelection.model
        };
      }
    }

    content.empty();
    content.createDiv({
      cls: 'csr-section-desc nexus-voice-section-desc',
      text: 'Defaults for microphone input, note read-aloud, and future live voice chat.'
    });

    let updateVoiceWarning = (): void => undefined;

    this.renderVoiceGroupLabel(content, 'Voice input');
    if (capabilities) {
      renderIngestModelDropdowns(content, {
        labelPrefix: 'Transcription',
        description: 'Used for chat microphone input and audio-file transcription.',
        providers: capabilities.transcriptionProviders,
        getSelection: () => llmSettings.defaultTranscriptionModel,
        onChange: async (provider, model) => {
          llmSettings.defaultTranscriptionModel = provider && model
            ? { provider, model }
            : undefined;
          await this.services.settings.saveSettings();
        },
        providerSettingName: 'Transcription provider',
        modelSettingName: 'Transcription model'
      });
    } else {
      content.createDiv({
        cls: 'setting-item-description',
        text: 'Transcription models are not available.'
      });
    }

    this.renderVoiceGroupLabel(content, 'Read aloud');
    this.renderSpeechSettings(content, llmSettings, () => updateVoiceWarning());

    this.renderVoiceGroupLabel(content, 'Live voice');
    this.renderRealtimeVoiceSettings(content, llmSettings, () => updateVoiceWarning());

    const warningEl = content.createDiv({ cls: 'nexus-voice-warning is-hidden' });
    updateVoiceWarning = (): void => {
      const messages = this.getVoiceWarningMessages(llmSettings);
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

  private renderSpeechSettings(
    parentEl: HTMLElement,
    llmSettings: LLMProviderSettings,
    onSelectionChange: () => void
  ): void {
    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;

    const getAvailability = (): SpeechProviderAvailability[] =>
      buildSpeechProviderAvailability(llmSettings, this.getSpeechAppStates());

    const getSelection = (): DefaultSpeechModelSettings => {
      const configured = llmSettings.defaultSpeechModel;
      if (configured?.source === 'user' || configured?.provider || configured?.model) {
        return configured;
      }

      const resolved = resolveDefaultSpeechSelection(llmSettings, getAvailability());
      return {
        provider: resolved.provider,
        model: resolved.model,
        voice: resolved.voice,
        source: 'auto'
      };
    };

    const updateVoiceOptions = (): void => {
      if (!voiceDropdown) return;
      const selection = getSelection();
      const model = getSpeechModel(selection.provider, selection.model);
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
          text: 'Select a speech provider first'
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
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = selection.model && selectedModelExists
        ? selection.model
        : models[0]?.id || '';
      updateVoiceOptions();
    };

    new Setting(parentEl)
      .setName('Speech provider')
      .setDesc('Normal text-to-speech models for reading notes and selected text.')
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
          llmSettings.defaultSpeechModel = provider && model
            ? this.buildSpeechDefault(model, undefined)
            : undefined;
          void this.services.settings.saveSettings().then(() => {
            updateModelOptions();
            onSelectionChange();
          });
        });
      });

    new Setting(parentEl)
      .setName('Speech model')
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        updateModelOptions();
        dropdown.onChange((modelId) => {
          const selection = getSelection();
          const model = getSpeechModel(selection.provider, modelId);
          if (model) {
            llmSettings.defaultSpeechModel = this.buildSpeechDefault(model, selection.voice);
          }
          void this.services.settings.saveSettings().then(() => {
            updateVoiceOptions();
            onSelectionChange();
          });
        });
      });

    new Setting(parentEl)
      .setName('Speech voice')
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        updateVoiceOptions();
        dropdown.onChange((voice) => {
          const selection = getSelection();
          if (selection.provider && selection.model) {
            llmSettings.defaultSpeechModel = {
              provider: selection.provider,
              model: selection.model,
              voice: voice || undefined,
              source: 'user'
            };
          }
          void this.services.settings.saveSettings().then(onSelectionChange);
        });
      });
  }

  private renderRealtimeVoiceSettings(
    parentEl: HTMLElement,
    llmSettings: LLMProviderSettings,
    onSelectionChange: () => void
  ): void {
    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;

    const getAvailability = (): RealtimeVoiceProviderAvailability[] =>
      buildRealtimeVoiceProviderAvailability(llmSettings, this.getRealtimeAppStates());

    const getSelection = (): DefaultRealtimeVoiceModelSettings => {
      const configured = llmSettings.defaultRealtimeVoiceModel;
      if (configured?.source === 'user' || configured?.provider || configured?.model) {
        return configured;
      }

      const resolved = resolveDefaultRealtimeVoiceSelection(llmSettings, getAvailability());
      return {
        provider: resolved.provider,
        model: resolved.model,
        voice: resolved.voice,
        source: 'auto'
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
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = selection.model && selectedModelExists
        ? selection.model
        : models[0]?.id || '';
      updateVoiceOptions();
    };

    new Setting(parentEl)
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
          llmSettings.defaultRealtimeVoiceModel = provider && model
            ? this.buildRealtimeDefault(model, undefined)
            : undefined;
          void this.services.settings.saveSettings().then(() => {
            updateModelOptions();
            onSelectionChange();
          });
        });
      });

    new Setting(parentEl)
      .setName('Live voice model')
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        updateModelOptions();
        dropdown.onChange((modelId) => {
          const selection = getSelection();
          const model = getRealtimeVoiceModel(selection.provider, modelId);
          if (model) {
            llmSettings.defaultRealtimeVoiceModel = this.buildRealtimeDefault(model, selection.voice);
          }
          void this.services.settings.saveSettings().then(() => {
            updateVoiceOptions();
            onSelectionChange();
          });
        });
      });

    new Setting(parentEl)
      .setName('Live voice')
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        updateVoiceOptions();
        dropdown.onChange((voice) => {
          const selection = getSelection();
          if (selection.provider && selection.model) {
            llmSettings.defaultRealtimeVoiceModel = {
              provider: selection.provider,
              model: selection.model,
              voice: voice || undefined,
              source: 'user'
            };
          }
          void this.services.settings.saveSettings().then(onSelectionChange);
        });
      });
  }

  private buildSpeechDefault(
    model: SpeechModelDeclaration,
    voice: string | undefined
  ): DefaultSpeechModelSettings {
    return {
      provider: model.provider,
      model: model.id,
      voice: voice || model.defaultVoice,
      source: 'user'
    };
  }

  private buildRealtimeDefault(
    model: RealtimeVoiceModelDeclaration,
    voice: string | undefined
  ): DefaultRealtimeVoiceModelSettings {
    return {
      provider: model.provider,
      model: model.id,
      voice: voice || model.defaultVoice,
      source: 'user'
    };
  }

  private getSpeechAppStates(): SpeechAppCapabilityStates {
    const elevenLabs = this.services.appManager?.getAvailableApps().find(app => app.id === 'elevenlabs');
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: elevenLabs.configured } }
      : {};
  }

  private getRealtimeAppStates(): RealtimeAppCapabilityStates {
    const elevenLabs = this.services.appManager?.getAvailableApps().find(app => app.id === 'elevenlabs');
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: elevenLabs.configured } }
      : {};
  }

  private getVoiceWarningMessages(llmSettings: LLMProviderSettings): string[] {
    const messages: string[] = [];
    const speechSelection = resolveDefaultSpeechSelection(
      llmSettings,
      buildSpeechProviderAvailability(llmSettings, this.getSpeechAppStates())
    );
    const realtimeSelection = resolveDefaultRealtimeVoiceSelection(
      llmSettings,
      buildRealtimeVoiceProviderAvailability(llmSettings, this.getRealtimeAppStates())
    );

    if (speechSelection.status === 'invalid' && speechSelection.reason) {
      messages.push(speechSelection.reason);
    }

    if (realtimeSelection.status === 'invalid' && realtimeSelection.reason) {
      messages.push(realtimeSelection.reason);
    }

    return messages;
  }

  private getProviderDisplayName(providerId: string): string {
    return ProviderUtils.getProviderDisplayName(providerId);
  }

  /**
   * Render the ingestion defaults section
   */
  private async renderIngestionSection(parentEl: HTMLElement): Promise<void> {
    const llmSettings = this.services.llmProviderSettings;
    if (!llmSettings) return;
    const pluginSettings = this.services.settings.settings;

    const providerManager = new LLMProviderManager(llmSettings, this.services.app.vault);
    const capabilities = await getIngestCapabilityOptions(providerManager);
    const normalizedOcrSelection = normalizeIngestSelection(
      capabilities.ocrProviders,
      llmSettings.defaultOcrModel?.provider,
      llmSettings.defaultOcrModel?.model
    );

    if (normalizedOcrSelection.provider && normalizedOcrSelection.model) {
      llmSettings.defaultOcrModel = {
        provider: normalizedOcrSelection.provider,
        model: normalizedOcrSelection.model
      };
    }

    const section = createDiv({ cls: 'csr-section' });
    const header = section.createDiv({ cls: 'csr-section-header' });
    header.setText('Ingestion');
    const content = section.createDiv({ cls: 'csr-section-content' });
    const ingestionSettingsContainer = content.createDiv();
    const isEnabled = pluginSettings.enableIngestion !== false;

    new Setting(content)
      .setName('Enable ingestion')
      .setDesc('Show PDF ingestion settings and enable drag-and-drop ingestion in chat.')
      .addToggle(toggle => {
        toggle
          .setValue(isEnabled)
          .onChange(async (value) => {
            pluginSettings.enableIngestion = value;
            if (value) {
              ingestionSettingsContainer.removeClass('nexus-ingest-confirm-hidden');
            } else {
              ingestionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
            }
            await this.services.settings.saveSettings();
          });
      });

    new Setting(content)
      .setName('Auto-convert new files')
      .setDesc('When supported PDF files are added to the vault, automatically convert them to sibling Markdown files using the defaults below.')
      .addToggle(toggle => {
        toggle
          .setValue(pluginSettings.autoIngestion === true)
          .onChange(async (value) => {
            pluginSettings.autoIngestion = value;
            await this.services.settings.saveSettings();
          });
      });

    if (!isEnabled) {
      ingestionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
    }

    // PDF processing mode
    let ocrSettingsContainer: HTMLElement | null = null;

    new Setting(ingestionSettingsContainer)
      .setName('Default PDF mode')
      .setDesc('Text extraction is free. Vision scan uses a model for scanned documents.')
      .addDropdown(dropdown => {
        dropdown
          .addOption('text', 'Text extraction')
          .addOption('vision', 'Vision scan')
          .setValue(llmSettings.defaultPdfMode || 'text')
          .onChange(async (value) => {
            llmSettings.defaultPdfMode = value as 'text' | 'vision';
            await this.services.settings.saveSettings();
            // Toggle OCR provider visibility
            if (ocrSettingsContainer) {
              if (value === 'vision') {
                ocrSettingsContainer.removeClass('nexus-ingest-confirm-hidden');
              } else {
                ocrSettingsContainer.addClass('nexus-ingest-confirm-hidden');
              }
            }
          });
      });

    // OCR provider/model (conditionally shown)
    ocrSettingsContainer = ingestionSettingsContainer.createDiv();
    if (llmSettings.defaultPdfMode !== 'vision') {
      ocrSettingsContainer.addClass('nexus-ingest-confirm-hidden');
    }

    renderIngestModelDropdowns(
      ocrSettingsContainer,
      {
        labelPrefix: 'Default OCR',
        description: 'Model for vision OCR when using vision mode.',
        providers: capabilities.ocrProviders,
        getSelection: () => llmSettings.defaultOcrModel,
        onChange: async (provider, model) => {
          llmSettings.defaultOcrModel = provider && model
            ? { provider, model }
            : undefined;
          await this.services.settings.saveSettings();
        }
      }
    );

    parentEl.appendChild(section);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }
}
