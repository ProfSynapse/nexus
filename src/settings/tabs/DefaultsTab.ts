/**
 * DefaultsTab - Default settings for new chats
 *
 * Uses ChatSettingsRenderer for identical UI to ChatSettingsModal.
 * Saves to plugin settings (defaults for all new chats).
 */

import { App, Setting, Notice, Platform } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { Settings } from '../../settings';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { ChatSettingsRenderer, ChatSettings } from '../../components/shared/ChatSettingsRenderer';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import {
  getIngestCapabilityOptions,
  normalizeIngestSelection,
  IngestProviderOption
} from '../../agents/ingestManager/tools/services/IngestCapabilityService';

export interface DefaultsTabServices {
  app: App;
  settings: Settings;
  llmProviderSettings?: LLMProviderSettings;
  workspaceService?: WorkspaceService;
  customPromptStorage?: CustomPromptStorageService;
}

export class DefaultsTab {
  private container: HTMLElement;
  private router: SettingsRouter;
  private services: DefaultsTabServices;
  private renderer: ChatSettingsRenderer | null = null;

  constructor(
    container: HTMLElement,
    router: SettingsRouter,
    services: DefaultsTabServices
  ) {
    this.container = container;
    this.router = router;
    this.services = services;

    this.loadDataAndRender();
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
      callbacks: {
        onSettingsChange: (settings) => this.saveSettings(settings)
      }
    });

    this.renderer.render();

    await this.renderIngestionSection(rendererContainer);

    // Embeddings section (desktop only) - insert before Temperature
    if (!Platform.isMobile) {
      // Find Temperature section to insert before it
      const headers = rendererContainer.querySelectorAll('.csr-section-header');
      let temperatureSection: Element | null = null;
      for (const header of Array.from(headers)) {
        if (header.textContent === 'Temperature') {
          temperatureSection = header.parentElement;
          break;
        }
      }

      const embeddingsSection = createDiv({ cls: 'csr-section' });
      const embeddingsHeader = embeddingsSection.createDiv({ cls: 'csr-section-header' });
      embeddingsHeader.setText('Embeddings');
      const embeddingsContent = embeddingsSection.createDiv({ cls: 'csr-section-content' });

      new Setting(embeddingsContent)
        .setName('Enable')
        .setDesc('Local AI for semantic search (~23MB download). Restart to apply.')
        .addToggle(toggle => {
          toggle
            .setValue(this.services.settings.settings.enableEmbeddings ?? true)
            .onChange(async (value) => {
              this.services.settings.settings.enableEmbeddings = value;
              await this.services.settings.saveSettings();
              new Notice(`Embeddings ${value ? 'enabled' : 'disabled'}. Restart Obsidian to apply.`);
            });
        });

      // Insert before Temperature, or append if not found
      if (temperatureSection) {
        rendererContainer.insertBefore(embeddingsSection, temperatureSection);
      } else {
        rendererContainer.appendChild(embeddingsSection);
      }
    }
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
    const normalizedTranscriptionSelection = normalizeIngestSelection(
      capabilities.transcriptionProviders,
      llmSettings.defaultTranscriptionModel?.provider,
      llmSettings.defaultTranscriptionModel?.model
    );

    if (normalizedOcrSelection.provider && normalizedOcrSelection.model) {
      llmSettings.defaultOcrModel = {
        provider: normalizedOcrSelection.provider,
        model: normalizedOcrSelection.model
      };
    }

    if (normalizedTranscriptionSelection.provider && normalizedTranscriptionSelection.model) {
      llmSettings.defaultTranscriptionModel = {
        provider: normalizedTranscriptionSelection.provider,
        model: normalizedTranscriptionSelection.model
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
      .setDesc('Show PDF/audio ingestion settings and enable drag-and-drop ingestion in chat.')
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

    if (!isEnabled) {
      ingestionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
    }

    // PDF processing mode
    let ocrSettingsContainer: HTMLElement | null = null;

    new Setting(ingestionSettingsContainer)
      .setName('Default PDF mode')
      .setDesc('Text extraction is free. Vision OCR uses an LLM for scanned documents.')
      .addDropdown(dropdown => {
        dropdown
          .addOption('text', 'Text extraction')
          .addOption('vision', 'Vision OCR')
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

    this.renderProviderModelDefaults(
      ocrSettingsContainer,
      'Default OCR',
      'Model for vision OCR when using vision mode.',
      capabilities.ocrProviders,
      () => llmSettings.defaultOcrModel,
      async (provider, model) => {
        llmSettings.defaultOcrModel = provider && model
          ? { provider, model }
          : undefined;
        await this.services.settings.saveSettings();
      }
    );

    this.renderProviderModelDefaults(
      ingestionSettingsContainer,
      'Default transcription',
      'Model for audio transcription.',
      capabilities.transcriptionProviders,
      () => llmSettings.defaultTranscriptionModel,
      async (provider, model) => {
        llmSettings.defaultTranscriptionModel = provider && model
          ? { provider, model }
          : undefined;
        await this.services.settings.saveSettings();
      }
    );

    const temperatureSection = this.findSectionByHeader(parentEl, 'Temperature');
    if (temperatureSection) {
      parentEl.insertBefore(section, temperatureSection);
    } else {
      parentEl.appendChild(section);
    }
  }

  private findSectionByHeader(parentEl: HTMLElement, headerText: string): HTMLElement | null {
    const headers = parentEl.querySelectorAll('.csr-section-header');
    for (const header of Array.from(headers)) {
      if (header.textContent === headerText && header.parentElement instanceof HTMLElement) {
        return header.parentElement;
      }
    }

    return null;
  }

  private renderProviderModelDefaults(
    container: HTMLElement,
    labelPrefix: string,
    description: string,
    providers: IngestProviderOption[],
    getSelection: () => { provider: string; model: string } | undefined,
    onChange: (provider: string | undefined, model: string | undefined) => Promise<void>
  ): void {
    let modelDropdown: HTMLSelectElement | null = null;

    const updateModelOptions = (): void => {
      if (!modelDropdown) {
        return;
      }

      const selection = getSelection();
      const providerId = selection?.provider;
      const provider = providers.find(option => option.id === providerId);
      const normalizedSelection = normalizeIngestSelection(
        providers,
        selection?.provider,
        selection?.model
      );

      modelDropdown.empty();

      if (!providerId || !provider || provider.models.length === 0) {
        modelDropdown.createEl('option', {
          value: '',
          text: providers.length === 0 ? `No ${labelPrefix.toLowerCase()} models available` : 'Select a provider first'
        });
        modelDropdown.disabled = true;
        return;
      }

      provider.models.forEach(model => {
        modelDropdown!.createEl('option', {
          value: model.id,
          text: model.name
        });
      });

      modelDropdown.disabled = false;
      modelDropdown.value = provider.models.some(model => model.id === normalizedSelection.model)
        ? normalizedSelection.model || provider.models[0].id
        : provider.models[0].id;
    };

    new Setting(container)
      .setName(`${labelPrefix} provider`)
      .setDesc(description)
      .addDropdown(dropdown => {
        if (providers.length === 0) {
          dropdown.addOption('', `No ${labelPrefix.toLowerCase()} providers available`);
          dropdown.setDisabled(true);
          return;
        }

        providers.forEach(provider => {
          dropdown.addOption(provider.id, provider.name);
        });

        const normalizedSelection = normalizeIngestSelection(
          providers,
          getSelection()?.provider,
          getSelection()?.model
        );

        dropdown.setValue(normalizedSelection.provider || providers[0].id);
        dropdown.onChange(async (value) => {
          const nextSelection = normalizeIngestSelection(providers, value, undefined);
          await onChange(nextSelection.provider, nextSelection.model);
          updateModelOptions();
        });
      });

    new Setting(container)
      .setName(`${labelPrefix} model`)
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        updateModelOptions();

        dropdown.onChange(async (value) => {
          const selection = getSelection();
          await onChange(selection?.provider, value || undefined);
          updateModelOptions();
        });
      });
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }
}
