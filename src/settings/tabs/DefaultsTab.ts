/**
 * DefaultsTab - Default settings for new chats
 *
 * Uses ChatSettingsRenderer for identical UI to ChatSettingsModal.
 * Saves to plugin settings (defaults for all new chats).
 */

import { App, Notice, Platform, Setting } from 'obsidian';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';
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

export interface DefaultsTabServices {
  app: App;
  settings: Settings;
  llmProviderSettings?: LLMProviderSettings;
  workspaceService?: WorkspaceService;
  customPromptStorage?: CustomPromptStorageService;
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

    new Setting(content)
      .setName('Auto-convert new files')
      .setDesc('When supported PDF or audio files are added to the vault, automatically convert them to sibling Markdown files using the defaults below.')
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
