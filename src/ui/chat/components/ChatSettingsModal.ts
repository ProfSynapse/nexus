/**
 * ChatSettingsModal - Modal for configuring chat session settings
 *
 * Uses ChatSettingsRenderer for identical UI to DefaultsTab.
 * Saves to conversation metadata (this session only).
 */

import { App, Modal, ButtonComponent, Plugin, Notice } from 'obsidian';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { ModelAgentManager } from '../services/ModelAgentManager';
import { ChatSettingsRenderer, ChatSettings, ChatSettingsOptions } from '../../../components/shared/ChatSettingsRenderer';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { Settings } from '../../../settings';
import { getContextWindowOverrideKey } from '../utils/ContextWindowSettings';
import { resolveSubagentTarget } from '../../../components/shared/chatSettings/subagentTarget';
import { getRegistryContextWindow } from '../../../services/llm/utils/modelCapabilityLookup';

/**
 * Type for the NexusPlugin with settings property
 * Used to access plugin settings in a type-safe way
 */
interface NexusPluginWithSettings extends Plugin {
  settings?: Settings;
}

export class ChatSettingsModal extends Modal {
  private workspaceService: WorkspaceService;
  private modelAgentManager: ModelAgentManager;
  private conversationId: string | null;
  private renderer: ChatSettingsRenderer | null = null;
  private pendingSettings: ChatSettings | null = null;
  private saveButton: ButtonComponent | null = null;
  private saveStatus: HTMLElement | null = null;
  private buttonContainer: HTMLElement | null = null;
  private saving = false;
  private ownsContextHandoff = false;
  private closed = false;

  constructor(
    app: App,
    conversationId: string | null,
    workspaceService: WorkspaceService,
    modelAgentManager: ModelAgentManager
  ) {
    super(app);
    this.conversationId = conversationId;
    this.workspaceService = workspaceService;
    this.modelAgentManager = modelAgentManager;
  }

  onOpen(): void {
    this.closed = false;
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Chat settings');
    this.modalEl.addClass('chat-settings-modal');

    // The renderer's container comes first so the form sits above the buttons
    // even though it fills in asynchronously.
    const rendererContainer = contentEl.createDiv('chat-settings-renderer');

    // Cancel / Save sit at the bottom of the modal, outside the scrolling content.
    this.buttonContainer?.remove();
    const buttonContainer = this.modalEl.createDiv('modal-button-container');
    this.buttonContainer = buttonContainer;
    this.saveStatus = buttonContainer.createEl('p', { text: '', cls: 'chat-settings-save-status' });
    this.saveStatus.setAttribute('role', 'status');
    this.saveStatus.setAttribute('aria-live', 'polite');
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    this.saveButton = new ButtonComponent(buttonContainer)
      .setButtonText('Save')
      .setCta()
      .onClick(() => {
        void this.handleSave();
      });

    // Load data and render
    void this.loadAndRender(rendererContainer);
  }

  private async loadAndRender(rendererContainer: HTMLElement): Promise<void> {
    const plugin = getNexusPlugin<NexusPluginWithSettings>(this.app);
    const llmProviderSettings = plugin?.settings?.settings?.llmProviders;

    if (!llmProviderSettings) {
      rendererContainer.createEl('p', { text: 'Settings not available' });
      return;
    }

    // Load workspaces and prompts
    const workspaces = await this.loadWorkspaces();
    const prompts = await this.loadPrompts();
    if (this.closed) return;

    // Get current settings from ModelAgentManager
    const workflowId = await this.modelAgentManager.getSelectedWorkflowId();
    if (this.closed) return;
    const initialSettings = this.getCurrentSettings();
    initialSettings.workflowId = workflowId;

    this.renderer = new ChatSettingsRenderer(rendererContainer, {
      app: this.app,
      surface: 'chat',
      llmProviderSettings,
      initialSettings,
      options: { workspaces, prompts },
      callbacks: {
        onSettingsChange: (settings) => {
          this.pendingSettings = settings;
        }
      }
    });

    this.renderer.render();
  }

  private async loadWorkspaces(): Promise<ChatSettingsOptions['workspaces']> {
    try {
      const workspaces = await this.workspaceService.listWorkspaceDiscovery();
      return workspaces.map(w => ({ id: w.id, name: w.name, context: w.context }));
    } catch {
      return [];
    }
  }

  private async loadPrompts(): Promise<Array<{ id: string; name: string }>> {
    try {
      const prompts = await this.modelAgentManager.getAvailablePrompts();
      return prompts.map(p => ({ id: p.id || p.name, name: p.name }));
    } catch {
      return [];
    }
  }

  private getCurrentSettings(): ChatSettings {
    const model = this.modelAgentManager.getSelectedModel();
    const prompt = this.modelAgentManager.getSelectedPrompt();
    const thinking = this.modelAgentManager.getThinkingSettings();
    const agentThinking = this.modelAgentManager.getAgentThinkingSettings();
    const contextNotes = this.modelAgentManager.getContextNotes();
    const temperature = this.modelAgentManager.getTemperature();

    // Get plugin defaults for image and agent model fallback
    const plugin = getNexusPlugin<NexusPluginWithSettings>(this.app);
    const llmSettings = plugin?.settings?.settings?.llmProviders;
    const contextWindowOverrides = { ...(llmSettings?.contextWindowOverrides || {}) };
    if (model) {
      const key = getContextWindowOverrideKey(model.providerId, model.modelId);
      contextWindowOverrides[key] = this.modelAgentManager.getEffectiveContextWindow();
    }

    const provider = model?.providerId || llmSettings?.defaultModel?.provider || '';
    const modelId = model?.modelId || llmSettings?.defaultModel?.model || '';
    const agentProvider = this.modelAgentManager.getAgentProvider() || llmSettings?.agentModel?.provider || undefined;
    const agentModel = this.modelAgentManager.getAgentModel() || llmSettings?.agentModel?.model || undefined;

    // This chat's subagent limit is one number; the renderer keys it by the
    // model the Subagents rows describe. A chat without its own limit shows
    // the default limit, which is what its subagents would use.
    const agentContextWindowOverrides: Record<string, number> = {};
    const agentTarget = resolveSubagentTarget({ provider, model: modelId, agentProvider, agentModel });
    if (agentTarget.provider && agentTarget.model) {
      const key = getContextWindowOverrideKey(agentTarget.provider, agentTarget.model);
      const agentContextWindow = this.modelAgentManager.getAgentContextWindow()
        ?? llmSettings?.agentContextWindowOverrides?.[key]
        ?? null;
      if (agentContextWindow !== null) agentContextWindowOverrides[key] = agentContextWindow;
    }

    return {
      provider,
      model: modelId,
      agentProvider,
      agentModel,
      thinking: {
        enabled: thinking?.enabled ?? false,
        effort: thinking?.effort ?? 'medium'
      },
      webSearch: this.modelAgentManager.getWebSearch(),
      contextWindowOverrides,
      agentThinking: {
        enabled: agentThinking?.enabled ?? false,
        effort: agentThinking?.effort ?? 'medium'
      },
      temperature: temperature,
      agentTemperature: this.modelAgentManager.getAgentTemperature(),
      agentContextWindowOverrides,
      imageProvider: this.modelAgentManager.getImageProvider() || llmSettings?.defaultImageModel?.provider || 'google',
      imageModel: this.modelAgentManager.getImageModel() || llmSettings?.defaultImageModel?.model || 'gemini-3.1-flash-image',
      speechProvider: this.modelAgentManager.getSpeechProvider() || llmSettings?.defaultSpeechModel?.provider,
      speechModel: this.modelAgentManager.getSpeechModel() || llmSettings?.defaultSpeechModel?.model,
      speechVoice: this.modelAgentManager.getSpeechVoice() || llmSettings?.defaultSpeechModel?.voice,
      realtimeVoiceProvider: this.modelAgentManager.getRealtimeVoiceProvider() || llmSettings?.defaultRealtimeVoiceModel?.provider,
      realtimeVoiceModel: this.modelAgentManager.getRealtimeVoiceModel() || llmSettings?.defaultRealtimeVoiceModel?.model,
      realtimeVoiceVoice: this.modelAgentManager.getRealtimeVoiceVoice() || llmSettings?.defaultRealtimeVoiceModel?.voice,
      transcriptionProvider: this.modelAgentManager.getTranscriptionProvider() || llmSettings?.defaultTranscriptionModel?.provider,
      transcriptionModel: this.modelAgentManager.getTranscriptionModel() || llmSettings?.defaultTranscriptionModel?.model,
      workspaceId: this.modelAgentManager.getSelectedWorkspaceId(),
      promptId: prompt?.id || prompt?.name || null,
      contextNotes: [...contextNotes]
    };
  }

  private async handleSave(): Promise<void> {
    if (this.saving || this.closed) return;
    if (!this.pendingSettings) {
      this.pendingSettings = this.renderer?.getSettings() || null;
    }

    if (!this.pendingSettings) {
      this.close();
      return;
    }

    this.saving = true;
    this.saveButton?.setDisabled(true);
    this.saveStatus?.setText('Preparing context…');
    try {
      const settings = {
        ...this.pendingSettings,
        contextWindowOverrides: this.pendingSettings.contextWindowOverrides
          ? { ...this.pendingSettings.contextWindowOverrides } : undefined
      };

      // Commit the model and active context budget together before other settings.
      if (settings.provider && settings.model) {
        const key = getContextWindowOverrideKey(settings.provider, settings.model);
        const override = settings.contextWindowOverrides?.[key];
        const selectedModel = this.modelAgentManager.getSelectedModel();
        const advertisedWindow = selectedModel?.providerId === settings.provider && selectedModel.modelId === settings.model
          ? selectedModel.contextWindow
          : (await this.modelAgentManager.getAvailableModels()).find(model =>
            model.providerId === settings.provider && model.modelId === settings.model)?.contextWindow;
        if (this.closed) return;
        this.ownsContextHandoff = true;
        let committed: boolean;
        try {
          committed = await this.modelAgentManager.requestContextChange({
            providerId: settings.provider,
            modelId: settings.model,
            contextWindowOverride: override ?? advertisedWindow
          });
        } finally {
          this.ownsContextHandoff = false;
        }
        if (this.closed) {
          if (committed) new Notice('Context change was already being saved and has been applied.');
          return;
        }
        if (!committed) return;
      }

      // The context window applies to this conversation only; Defaults own the value for new chats.
      if (this.closed) return;

      // Update prompt
      if (settings.promptId) {
        const availablePrompts = await this.modelAgentManager.getAvailablePrompts();
        if (this.closed) return;
        const prompt = availablePrompts.find(p => p.id === settings.promptId || p.name === settings.promptId);
        await this.modelAgentManager.handlePromptChange(prompt || null);
      } else {
        await this.modelAgentManager.handlePromptChange(null);
      }

      // Update workspace
      const currentWorkflow = await this.modelAgentManager.getSelectedWorkflowId();
      if (this.closed) return;
      if (settings.workspaceId) {
        if (settings.workspaceId !== this.modelAgentManager.getSelectedWorkspaceId() || (settings.workflowId ?? null) !== currentWorkflow) await this.modelAgentManager.setWorkspaceContext(settings.workspaceId, settings.workflowId || undefined);
      } else {
        if (this.modelAgentManager.getSelectedWorkspaceId() || currentWorkflow) await this.modelAgentManager.clearWorkspaceContext();
      }

      // Update thinking
      this.modelAgentManager.setThinkingSettings(settings.thinking);
      this.modelAgentManager.setWebSearch(settings.webSearch === true);

      // Update agent model
      this.modelAgentManager.setAgentModel(
        settings.agentProvider || null,
        settings.agentModel || null
      );

      // Update agent thinking
      if (settings.agentThinking) {
        this.modelAgentManager.setAgentThinkingSettings(settings.agentThinking);
      }

      // Subagent Creativity and context limit for this chat
      if (typeof settings.agentTemperature === 'number') {
        this.modelAgentManager.setAgentTemperature(settings.agentTemperature);
      }
      this.modelAgentManager.setAgentContextWindow(this.resolveAgentContextWindow(settings));

      // Update temperature
      this.modelAgentManager.setTemperature(settings.temperature);

      // Update context notes
      await this.modelAgentManager.setContextNotes(settings.contextNotes);
      if (this.closed) return;

      // Update image model
      this.modelAgentManager.setImageModel(settings.imageProvider, settings.imageModel);

      // Update speech settings
      this.modelAgentManager.setSpeechSettings(
        settings.speechProvider || null,
        settings.speechModel || null,
        settings.speechVoice || null
      );

      // Update realtime voice settings
      this.modelAgentManager.setRealtimeVoiceSettings(
        settings.realtimeVoiceProvider || null,
        settings.realtimeVoiceModel || null,
        settings.realtimeVoiceVoice || null
      );

      // Update transcription model
      this.modelAgentManager.setTranscriptionModel(
        settings.transcriptionProvider || null,
        settings.transcriptionModel || null
      );

      // Save to conversation metadata; with no conversation open, the next new one adopts them.
      if (this.conversationId) {
        await this.modelAgentManager.saveToConversation(this.conversationId);
      } else {
        this.modelAgentManager.carrySelectionsIntoNextConversation();
      }

      if (!this.closed) this.close();
    } catch (error) {
      console.error('[ChatSettingsModal] Error saving settings:', error);
      if (!this.closed) new Notice(error instanceof Error ? error.message : 'Chat settings could not be saved');
    } finally {
      this.saving = false;
      if (!this.closed) {
        this.saveButton?.setDisabled(false);
        this.saveStatus?.setText('');
      }
    }
  }

  /**
   * The subagent limit to keep for this chat. The model maximum is stored as
   * "no limit", except when Defaults set a lower one for that model: then the
   * maximum is kept explicitly so this chat does not fall back to the default.
   */
  private resolveAgentContextWindow(settings: ChatSettings): number | null {
    const target = resolveSubagentTarget(settings);
    if (!target.provider || !target.model) return null;
    const key = getContextWindowOverrideKey(target.provider, target.model);
    const chosen = settings.agentContextWindowOverrides?.[key];
    if (typeof chosen === 'number') return chosen;
    const plugin = getNexusPlugin<NexusPluginWithSettings>(this.app);
    const defaultLimit = plugin?.settings?.settings?.llmProviders?.agentContextWindowOverrides?.[key];
    if (typeof defaultLimit !== 'number') return null;
    return getRegistryContextWindow(target.provider, target.model) ?? null;
  }

  onClose(): void {
    this.closed = true;
    if (this.ownsContextHandoff) this.modelAgentManager.cancelContextHandoff();
    this.renderer?.destroy();
    this.renderer = null;
    this.pendingSettings = null;
    this.buttonContainer?.remove();
    this.buttonContainer = null;
    this.contentEl.empty();
  }
}
