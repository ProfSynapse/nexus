/**
 * DefaultsTab - Default settings for new chats
 *
 * Uses ChatSettingsRenderer for the same layout as the Chat settings modal and
 * adds the Defaults-only folds (Video, File conversion, Semantic search).
 * Every change is persisted through one save queue, so no two writes of the
 * plugin settings race each other.
 */

import { App, Notice, Platform } from 'obsidian';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { Settings } from '../../settings';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { ChatSettingsRenderer, ChatSettings, ChatSettingsOptions } from '../../components/shared/ChatSettingsRenderer';
import type { FoldDefinition } from '../../components/shared/chatSettings/types';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { getIngestCapabilityOptions } from '../../agents/ingestManager/tools/services/IngestCapabilityService';
import { AppManager } from '../../services/apps/AppManager';
import { FoldStateStore } from '../../components/shared/settings/FoldStateStore';
import { VideoSettings } from './defaults/VideoSettings';
import { FileConversionSettings } from './defaults/FileConversionSettings';
import { SemanticSearchSettings, type SemanticSearchRuntime } from './defaults/SemanticSearchSettings';
import { SemanticSearchOffModal } from './defaults/SemanticSearchOffModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { SEMANTIC_DELETE_MODAL_COPY } from '../../components/shared/chatSettings/copy';

export interface DefaultsTabServices {
  app: App;
  settings: Settings;
  llmProviderSettings?: LLMProviderSettings;
  workspaceService?: WorkspaceService;
  customPromptStorage?: CustomPromptStorageService;
  appManager?: AppManager;
  /**
   * Desktop semantic search runtime, for the Semantic search fold's status,
   * hot-apply and index deletion. Without it the fold shows only the switch
   * state and saves the setting.
   */
  semanticSearch?: {
    getRuntime(): SemanticSearchRuntime | null;
    applyEnabled(enabled: boolean): Promise<void>;
  };
}

/**
 * Reduce free-text input to a safe single folder NAME: trim, collapse path
 * separators and leading dots so the value can never escape the storage root
 * or become a nested path. Returns '' for empty/invalid input so the caller
 * can fall back to the default.
 */
export function sanitizeSubfolderName(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '')
    .replace(/^\.+/, '')
    .trim();
}

export class DefaultsTab {
  private container: HTMLElement;
  private services: DefaultsTabServices;
  private renderer: ChatSettingsRenderer | null = null;
  private settingsSaveQueue: Promise<void> = Promise.resolve();

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

    this.render(workspaces, prompts);
  }

  private async loadWorkspaces(): Promise<ChatSettingsOptions['workspaces']> {
    if (!this.services.workspaceService) return [];

    try {
      const workspaces = await this.services.workspaceService.getAllWorkspaces();
      // The prompt binding travels with each workspace so choosing one can preselect its prompt.
      return workspaces.map(w => ({ id: w.id, name: w.name, dedicatedAgentId: w.dedicatedAgentId, context: w.context }));
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
    // A read-aloud or live voice default counts as chosen once it has a source
    // of 'user' or a provider/model; otherwise the automatic pick applies.
    const speech = llmSettings?.defaultSpeechModel;
    const speechChosen = speech?.source === 'user' || !!speech?.provider || !!speech?.model;
    const realtime = llmSettings?.defaultRealtimeVoiceModel;
    const realtimeChosen = realtime?.source === 'user' || !!realtime?.provider || !!realtime?.model;
    const video = llmSettings?.defaultVideoModel;

    return {
      provider: llmSettings?.defaultModel?.provider || '',
      model: llmSettings?.defaultModel?.model || '',
      contextWindowOverrides: { ...(llmSettings?.contextWindowOverrides ?? {}) },
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
      agentTemperature: llmSettings?.agentTemperature,
      agentContextWindowOverrides: { ...(llmSettings?.agentContextWindowOverrides ?? {}) },
      imageProvider: llmSettings?.defaultImageModel?.provider || 'google',
      imageModel: llmSettings?.defaultImageModel?.model || 'gemini-3.1-flash-image',
      speechProvider: speechChosen ? speech?.provider : undefined,
      speechModel: speechChosen ? speech?.model : undefined,
      speechVoice: speechChosen ? speech?.voice : undefined,
      speechSource: speechChosen ? speech?.source : undefined,
      realtimeVoiceProvider: realtimeChosen ? realtime?.provider : undefined,
      realtimeVoiceModel: realtimeChosen ? realtime?.model : undefined,
      realtimeVoiceVoice: realtimeChosen ? realtime?.voice : undefined,
      realtimeVoiceSource: realtimeChosen ? realtime?.source : undefined,
      transcriptionProvider: llmSettings?.defaultTranscriptionModel?.provider,
      transcriptionModel: llmSettings?.defaultTranscriptionModel?.model,
      videoProvider: video?.provider,
      videoModel: video?.model,
      videoAspectRatio: video?.aspectRatio,
      videoResolution: video?.resolution,
      workspaceId: pluginSettings.defaultWorkspaceId || null,
      promptId: pluginSettings.defaultPromptId || null,
      contextNotes: [...(pluginSettings.defaultContextNotes || [])]
    };
  }

  /**
   * Save settings to plugin
   */
  private async saveSettings(settings: ChatSettings): Promise<void> {
    const llmSettings = this.services.llmProviderSettings;
    const pluginSettings = this.services.settings.settings;

    // Defaults apply to new chats only; an open chat keeps its own context budget.
    if (llmSettings) {
      llmSettings.defaultModel = {
        provider: settings.provider,
        model: settings.model
      };
      llmSettings.contextWindowOverrides = { ...(settings.contextWindowOverrides ?? {}) };
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
      // Subagent Creativity is written only once set; until then it follows the chat default.
      if (typeof settings.agentTemperature === 'number') {
        llmSettings.agentTemperature = settings.agentTemperature;
      }
      const agentOverrides = { ...(settings.agentContextWindowOverrides ?? {}) };
      if (Object.keys(agentOverrides).length > 0 || llmSettings.agentContextWindowOverrides) {
        llmSettings.agentContextWindowOverrides = agentOverrides;
      }
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
      // Voice defaults are written only once the user has picked them; until
      // then the automatic pick stays automatic.
      if (settings.speechSource === 'user') {
        llmSettings.defaultSpeechModel = settings.speechProvider
          ? { provider: settings.speechProvider, model: settings.speechModel, voice: settings.speechVoice, source: 'user' }
          : undefined;
      }
      if (settings.realtimeVoiceSource === 'user') {
        llmSettings.defaultRealtimeVoiceModel = settings.realtimeVoiceProvider
          ? { provider: settings.realtimeVoiceProvider, model: settings.realtimeVoiceModel, voice: settings.realtimeVoiceVoice, source: 'user' }
          : undefined;
      }
      if (settings.videoProvider && settings.videoModel) {
        llmSettings.defaultVideoModel = {
          provider: settings.videoProvider,
          model: settings.videoModel,
          aspectRatio: settings.videoAspectRatio,
          resolution: settings.videoResolution
        };
      }
      pluginSettings.llmProviders = llmSettings;
    }

    pluginSettings.defaultWorkspaceId = settings.workspaceId || undefined;
    pluginSettings.defaultPromptId = settings.promptId || undefined;
    pluginSettings.defaultContextNotes = [...settings.contextNotes];

    await this.services.settings.saveSettings();
  }

  /**
   * Apply a change and queue a save behind any save already in flight. Every
   * write from this tab goes through here.
   */
  private enqueueSave(mutate?: () => void | Promise<void>): void {
    this.settingsSaveQueue = this.settingsSaveQueue
      .then(async () => {
        await mutate?.();
        await this.services.settings.saveSettings();
      })
      .catch(error => {
        new Notice(error instanceof Error ? error.message : 'Defaults could not be saved');
      });
  }

  private buildExtraFolds(llmSettings: LLMProviderSettings): FoldDefinition[] {
    const pluginSettings = () => this.services.settings.settings;
    const folds: FoldDefinition[] = [
      new VideoSettings(),
      new FileConversionSettings({
        getPluginSettings: pluginSettings,
        getLlmSettings: () => llmSettings,
        save: mutate => {
          // Apply now so the redrawn rows read the new value; persist in order.
          mutate();
          this.enqueueSave();
        },
        loadOcrProviders: async () =>
          (await getIngestCapabilityOptions(new LLMProviderManager(llmSettings, this.services.app.vault))).ocrProviders
      })
    ];
    if (Platform.isDesktop) {
      const semantic = this.services.semanticSearch;
      const app = this.services.app;
      folds.push(new SemanticSearchSettings({
        isEnabled: () => pluginSettings().enableEmbeddings ?? true,
        setEnabled: enabled => {
          pluginSettings().enableEmbeddings = enabled;
          this.enqueueSave();
        },
        applyEnabled: enabled => semantic?.applyEnabled(enabled) ?? Promise.resolve(),
        getRuntime: () => semantic?.getRuntime() ?? null,
        confirmTurnOff: () => SemanticSearchOffModal.confirm(app),
        confirmDeleteIndex: () => ConfirmModal.confirm(app, {
          variant: 'delete',
          title: SEMANTIC_DELETE_MODAL_COPY.title,
          body: SEMANTIC_DELETE_MODAL_COPY.body,
          cancelLabel: SEMANTIC_DELETE_MODAL_COPY.cancel,
          ctaLabel: SEMANTIC_DELETE_MODAL_COPY.confirm
        })
      }));
    }
    return folds;
  }

  /**
   * Main render method
   */
  private render(
    workspaces: ChatSettingsOptions['workspaces'],
    prompts: Array<{ id: string; name: string }>
  ): void {
    this.renderer?.destroy();
    this.renderer = null;
    this.container.empty();

    const llmSettings = this.services.llmProviderSettings;
    if (!llmSettings) {
      this.container.createEl('p', { text: 'Settings not available' });
      return;
    }

    const rendererContainer = this.container.createDiv();
    const pluginSettings = this.services.settings.settings;
    const defaultSubfolder = DEFAULT_STORAGE_SETTINGS.audioSubfolder ?? 'audio';

    this.renderer = new ChatSettingsRenderer(rendererContainer, {
      app: this.services.app,
      surface: 'defaults',
      foldStore: new FoldStateStore(this.services.app),
      llmProviderSettings: llmSettings,
      initialSettings: this.getCurrentSettings(),
      options: { workspaces, prompts },
      extraFolds: this.buildExtraFolds(llmSettings),
      // The folder NAME under the configured storage root where saved read-aloud
      // audio is written; never a path, never a hardcoded root.
      voiceAudioFolder: {
        placeholder: defaultSubfolder,
        getValue: () => pluginSettings.storage?.audioSubfolder ?? defaultSubfolder,
        onChange: value => {
          this.enqueueSave(() => {
            const storage = pluginSettings.storage ?? { ...DEFAULT_STORAGE_SETTINGS };
            storage.audioSubfolder = sanitizeSubfolderName(value) || defaultSubfolder;
            pluginSettings.storage = storage;
          });
        }
      },
      callbacks: {
        onSettingsChange: (settings) => {
          // Serialize committed changes; slider drags never enqueue a save.
          const snapshot = {
            ...settings,
            contextNotes: [...settings.contextNotes],
            contextWindowOverrides: { ...settings.contextWindowOverrides },
            agentContextWindowOverrides: { ...settings.agentContextWindowOverrides }
          };
          this.settingsSaveQueue = this.settingsSaveQueue.then(() => this.saveSettings(snapshot)).catch(error => {
            new Notice(error instanceof Error ? error.message : 'Defaults could not be saved');
          });
        }
      }
    });

    this.renderer.render();
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }
}
