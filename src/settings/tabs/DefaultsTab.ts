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
import { VISION_PROVIDERS, TRANSCRIPTION_PROVIDERS } from '../../agents/ingestManager/types';

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

    this.render(workspaces, prompts);
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
  private render(
    workspaces: Array<{ id: string; name: string }>,
    prompts: Array<{ id: string; name: string }>
  ): void {
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

    // Ingestion defaults section (always visible)
    this.renderIngestionSection(rendererContainer);
  }

  /**
   * Render the ingestion defaults section
   */
  private renderIngestionSection(parentEl: HTMLElement): void {
    const llmSettings = this.services.llmProviderSettings;
    if (!llmSettings) return;

    const section = createDiv({ cls: 'csr-section' });
    const header = section.createDiv({ cls: 'csr-section-header' });
    header.setText('Ingestion');
    const content = section.createDiv({ cls: 'csr-section-content' });

    // PDF processing mode
    let ocrProviderSetting: HTMLElement | null = null;

    new Setting(content)
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
            if (ocrProviderSetting) {
              if (value === 'vision') {
                ocrProviderSetting.removeClass('nexus-ingest-confirm-hidden');
              } else {
                ocrProviderSetting.addClass('nexus-ingest-confirm-hidden');
              }
            }
          });
      });

    // OCR provider/model (conditionally shown)
    ocrProviderSetting = content.createDiv();
    if (llmSettings.defaultPdfMode !== 'vision') {
      ocrProviderSetting.addClass('nexus-ingest-confirm-hidden');
    }

    new Setting(ocrProviderSetting)
      .setName('Default OCR provider')
      .setDesc('Provider for vision OCR when using vision mode.')
      .addDropdown(dropdown => {
        for (const p of VISION_PROVIDERS) {
          dropdown.addOption(p.id, p.name);
        }
        dropdown.setValue(llmSettings.defaultOcrModel?.provider || 'openai');
        dropdown.onChange(async (value) => {
          if (!llmSettings.defaultOcrModel) {
            llmSettings.defaultOcrModel = { provider: value, model: '' };
          } else {
            llmSettings.defaultOcrModel.provider = value;
          }
          await this.services.settings.saveSettings();
        });
      });

    // Transcription provider/model
    new Setting(content)
      .setName('Default transcription provider')
      .setDesc('Provider for audio transcription (Whisper API).')
      .addDropdown(dropdown => {
        for (const p of TRANSCRIPTION_PROVIDERS) {
          dropdown.addOption(p.id, p.name);
        }
        dropdown.setValue(llmSettings.defaultTranscriptionModel?.provider || 'openai');
        dropdown.onChange(async (value) => {
          if (!llmSettings.defaultTranscriptionModel) {
            llmSettings.defaultTranscriptionModel = { provider: value, model: '' };
          } else {
            llmSettings.defaultTranscriptionModel.provider = value;
          }
          await this.services.settings.saveSettings();
        });
      });

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
