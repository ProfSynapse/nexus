/**
 * ChatSettingsModal - Modal for configuring chat session settings
 *
 * Uses ChatSettingsRenderer for identical UI to DefaultsTab.
 * Saves to conversation metadata (this session only).
 */

import { App, Modal, ButtonComponent, Plugin } from 'obsidian';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { ModelAgentManager } from '../services/ModelAgentManager';
import { ChatSettingsRenderer, ChatSettings } from '../../../components/shared/ChatSettingsRenderer';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { Settings } from '../../../settings';

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

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('chat-settings-modal');

    // Header with buttons
    const header = contentEl.createDiv('chat-settings-header');
    header.createEl('h2', { text: 'Chat Settings' });

    const buttonContainer = header.createDiv('chat-settings-buttons');
    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Save')
      .setCta()
      .onClick(() => this.handleSave());

    // Load data and render
    await this.loadAndRender(contentEl);
  }

  private async loadAndRender(contentEl: HTMLElement): Promise<void> {
    const plugin = getNexusPlugin<NexusPluginWithSettings>(this.app);
    const llmProviderSettings = plugin?.settings?.settings?.llmProviders;

    if (!llmProviderSettings) {
      contentEl.createEl('p', { text: 'Settings not available' });
      return;
    }

    // Load workspaces and prompts
    const workspaces = await this.loadWorkspaces();
    const prompts = await this.loadPrompts();

    // Get current settings from ModelAgentManager
    const initialSettings = this.getCurrentSettings();

    // Create renderer
    const rendererContainer = contentEl.createDiv('chat-settings-renderer');

    this.renderer = new ChatSettingsRenderer(rendererContainer, {
      app: this.app,
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

  private async loadWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    try {
      const workspaces = await this.workspaceService.listWorkspaces();
      return workspaces.map(w => ({ id: w.id, name: w.name }));
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

    return {
      provider: model?.providerId || llmSettings?.defaultModel?.provider || '',
      model: model?.modelId || llmSettings?.defaultModel?.model || '',
      agentProvider: this.modelAgentManager.getAgentProvider() || llmSettings?.agentModel?.provider || undefined,
      agentModel: this.modelAgentManager.getAgentModel() || llmSettings?.agentModel?.model || undefined,
      thinking: {
        enabled: thinking?.enabled ?? false,
        effort: thinking?.effort ?? 'medium'
      },
      agentThinking: {
        enabled: agentThinking?.enabled ?? false,
        effort: agentThinking?.effort ?? 'medium'
      },
      temperature: temperature,
      imageProvider: llmSettings?.defaultImageModel?.provider || 'google',
      imageModel: llmSettings?.defaultImageModel?.model || 'gemini-2.5-flash-image',
      workspaceId: this.modelAgentManager.getSelectedWorkspaceId(),
      promptId: prompt?.id || prompt?.name || null,
      contextNotes: [...contextNotes]
    };
  }

  private async handleSave(): Promise<void> {
    if (!this.pendingSettings) {
      this.pendingSettings = this.renderer?.getSettings() || null;
    }

    if (!this.pendingSettings) {
      this.close();
      return;
    }

    try {
      const settings = this.pendingSettings;

      // Update model
      const availableModels = await this.modelAgentManager.getAvailableModels();
      const model = availableModels.find(
        m => m.providerId === settings.provider && m.modelId === settings.model
      );
      if (model) {
        this.modelAgentManager.handleModelChange(model);
      }

      // Update prompt
      if (settings.promptId) {
        const availablePrompts = await this.modelAgentManager.getAvailablePrompts();
        const prompt = availablePrompts.find(p => p.id === settings.promptId || p.name === settings.promptId);
        await this.modelAgentManager.handlePromptChange(prompt || null);
      } else {
        await this.modelAgentManager.handlePromptChange(null);
      }

      // Update workspace
      if (settings.workspaceId) {
        const workspace = await this.workspaceService.getWorkspace(settings.workspaceId);
        if (workspace?.context) {
          await this.modelAgentManager.setWorkspaceContext(settings.workspaceId, workspace.context);
        }
      } else {
        await this.modelAgentManager.clearWorkspaceContext();
      }

      // Update thinking
      this.modelAgentManager.setThinkingSettings(settings.thinking);

      // Update agent model
      this.modelAgentManager.setAgentModel(
        settings.agentProvider || null,
        settings.agentModel || null
      );

      // Update agent thinking
      if (settings.agentThinking) {
        this.modelAgentManager.setAgentThinkingSettings(settings.agentThinking);
      }

      // Update temperature
      this.modelAgentManager.setTemperature(settings.temperature);

      // Update context notes
      await this.modelAgentManager.setContextNotes(settings.contextNotes);

      // Save to conversation metadata
      if (this.conversationId) {
        await this.modelAgentManager.saveToConversation(this.conversationId);
      }

      this.close();
    } catch (error) {
      console.error('[ChatSettingsModal] Error saving settings:', error);
    }
  }

  onClose() {
    this.renderer?.destroy();
    this.renderer = null;
    this.pendingSettings = null;
    this.contentEl.empty();
  }
}
