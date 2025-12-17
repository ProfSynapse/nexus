/**
 * ModelAgentManager - Handles model and agent selection, loading, and state management
 * Refactored to use extracted utilities following SOLID principles
 */

import { ModelOption, AgentOption } from '../types/SelectionTypes';
import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { SystemPromptBuilder, AgentSummary, ToolAgentInfo } from './SystemPromptBuilder';
import { ContextNotesManager } from './ContextNotesManager';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import { AgentConfigurationUtility } from '../utils/AgentConfigurationUtility';
import { WorkspaceIntegrationService } from './WorkspaceIntegrationService';
import { getWebLLMLifecycleManager } from '../../../services/llm/adapters/webllm/WebLLMLifecycleManager';
import { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import type NexusPlugin from '../../../main';
import type { App } from 'obsidian';

/**
 * App type with plugin registry access
 */
type AppWithPlugins = {
  plugins?: {
    plugins?: Record<string, NexusPlugin>;
  };
} & Omit<App, 'plugins'>;

/**
 * Plugin interface with settings structure
 */
interface PluginWithSettings {
  settings?: {
    settings?: {
      llmProviders?: {
        defaultThinking?: ThinkingSettings;
      };
      defaultWorkspaceId?: string;
      defaultAgentId?: string;
    };
  };
  serviceManager?: {
    getServiceIfReady?: (name: string) => any;
  };
  connector?: {
    agentRegistry?: {
      getAllAgents: () => Map<string, any>;
    };
  };
}

export interface ModelAgentManagerEvents {
  onModelChanged: (model: ModelOption | null) => void;
  onAgentChanged: (agent: AgentOption | null) => void;
  onSystemPromptChanged: (systemPrompt: string | null) => void;
}

export class ModelAgentManager {
  private selectedModel: ModelOption | null = null;
  private selectedAgent: AgentOption | null = null;
  private currentSystemPrompt: string | null = null;
  private selectedWorkspaceId: string | null = null;
  private workspaceContext: WorkspaceContext | null = null;
  private loadedWorkspaceData: any = null; // Full comprehensive workspace data from LoadWorkspaceTool
  private contextNotesManager: ContextNotesManager;
  private currentConversationId: string | null = null;
  private messageEnhancement: MessageEnhancement | null = null;
  private systemPromptBuilder: SystemPromptBuilder;
  private workspaceIntegration: WorkspaceIntegrationService;
  private thinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };

  constructor(
    private app: any, // Obsidian App
    private events: ModelAgentManagerEvents,
    private conversationService?: any, // Optional ConversationService for persistence
    conversationId?: string
  ) {
    this.currentConversationId = conversationId || null;

    // Initialize services
    this.contextNotesManager = new ContextNotesManager();
    this.workspaceIntegration = new WorkspaceIntegrationService(app);
    this.systemPromptBuilder = new SystemPromptBuilder(
      this.workspaceIntegration.readNoteContent.bind(this.workspaceIntegration),
      this.workspaceIntegration.loadWorkspace.bind(this.workspaceIntegration)
    );
  }

  /**
   * Initialize with plugin defaults (model, workspace, agent)
   * Call this when no conversation exists (e.g., welcome state)
   */
  async initializeDefaults(): Promise<void> {
    await this.initializeDefaultModel();
  }

  /**
   * Initialize from conversation metadata (if available), otherwise use plugin default
   */
  async initializeFromConversation(conversationId: string): Promise<void> {
    try {
      // Try to load from conversation metadata first
      if (this.conversationService) {
        const conversation = await this.conversationService.getConversation(conversationId);
        const chatSettings = conversation?.metadata?.chatSettings;

        // Check if chatSettings has meaningful content (not just empty object)
        const hasMeaningfulSettings = chatSettings && (
          chatSettings.providerId ||
          chatSettings.modelId ||
          chatSettings.agentId ||
          chatSettings.workspaceId
        );

        if (hasMeaningfulSettings) {
          await this.restoreFromConversationMetadata(chatSettings);
          return; // Successfully loaded from metadata
        }
      }

      // Fall back to plugin default if no meaningful metadata
      await this.initializeDefaultModel();
    } catch (error) {
      await this.initializeDefaultModel();
    }
  }

  /**
   * Restore settings from conversation metadata
   */
  private async restoreFromConversationMetadata(settings: any): Promise<void> {
    const availableModels = await this.getAvailableModels();
    const availableAgents = await this.getAvailableAgents();

    // Restore model
    if (settings.providerId && settings.modelId) {
      const model = availableModels.find(
        m => m.providerId === settings.providerId && m.modelId === settings.modelId
      );

      if (model) {
        this.selectedModel = model;
        this.events.onModelChanged(model);
      } else {
        await this.initializeDefaultModel();
      }
    }

    // Restore agent
    if (settings.agentId) {
      const agent = availableAgents.find(a => a.id === settings.agentId);
      if (agent) {
        this.selectedAgent = agent;
        this.currentSystemPrompt = agent.systemPrompt || null;
        this.events.onAgentChanged(agent);
      }
    }

    // Restore workspace
    if (settings.workspaceId) {
      await this.restoreWorkspace(settings.workspaceId, settings.sessionId);
    }

    // Restore context notes
    if (settings.contextNotes && Array.isArray(settings.contextNotes)) {
      this.contextNotesManager.setNotes(settings.contextNotes);
    }

    // Restore thinking settings
    if (settings.thinking) {
      this.thinkingSettings = {
        enabled: settings.thinking.enabled ?? false,
        effort: settings.thinking.effort ?? 'medium'
      };
    }
  }

  /**
   * Restore workspace from settings - loads full comprehensive data
   */
  private async restoreWorkspace(workspaceId: string, sessionId?: string): Promise<void> {
    this.selectedWorkspaceId = workspaceId;

    try {
      // Load full comprehensive workspace data (same as #workspace suggester)
      const fullWorkspaceData = await this.workspaceIntegration.loadWorkspace(workspaceId);

      if (fullWorkspaceData) {
        this.loadedWorkspaceData = fullWorkspaceData;
        // Also extract basic context for backward compatibility
        this.workspaceContext = fullWorkspaceData.context || fullWorkspaceData.workspaceContext || null;
      }

      // Bind session to workspace
      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, workspaceId);
    } catch (error) {
      console.error('[ModelAgentManager] Failed to restore workspace:', error);
      // Clear workspace data on failure
      this.loadedWorkspaceData = null;
      this.workspaceContext = null;
    }
  }

  /**
   * Initialize from plugin settings defaults (model, workspace, agent, thinking)
   */
  private async initializeDefaultModel(): Promise<void> {
    try {
      // Initialize default model
      const availableModels = await this.getAvailableModels();
      const defaultModel = await ModelSelectionUtility.findDefaultModelOption(this.app, availableModels);

      if (defaultModel) {
        this.selectedModel = defaultModel;
        this.events.onModelChanged(defaultModel);
      }

      // Clear state first
      this.selectedAgent = null;
      this.currentSystemPrompt = null;
      this.selectedWorkspaceId = null;
      this.workspaceContext = null;
      this.loadedWorkspaceData = null;
      this.contextNotesManager.clear();

      // Get plugin settings for defaults
      const { getNexusPlugin } = await import('../../../utils/pluginLocator');
      const plugin = getNexusPlugin<NexusPlugin>(this.app) as unknown as PluginWithSettings | null;
      const settings = plugin?.settings?.settings;

      // Load default thinking settings
      const llmProviders = settings?.llmProviders;
      if (llmProviders?.defaultThinking) {
        this.thinkingSettings = {
          enabled: llmProviders.defaultThinking.enabled ?? false,
          effort: llmProviders.defaultThinking.effort ?? 'medium'
        };
      }

      // Load default workspace if set
      if (settings?.defaultWorkspaceId) {
        try {
          await this.restoreWorkspace(settings.defaultWorkspaceId, undefined);
        } catch (error) {
          // Failed to load default workspace
        }
      }

      // Load default agent if set
      if (settings?.defaultAgentId) {
        try {
          const availableAgents = await this.getAvailableAgents();
          const defaultAgent = availableAgents.find(a => a.id === settings.defaultAgentId || a.name === settings.defaultAgentId);
          if (defaultAgent) {
            this.selectedAgent = defaultAgent;
            this.currentSystemPrompt = defaultAgent.systemPrompt || null;
            this.events.onAgentChanged(defaultAgent);
            this.events.onSystemPromptChanged(this.currentSystemPrompt);
            return; // Agent was set, don't reset
          }
        } catch (error) {
          // Failed to load default agent
        }
      }

      // Notify listeners about the state (no agent selected)
      this.events.onAgentChanged(null);
      this.events.onSystemPromptChanged(null);
    } catch (error) {
      // Failed to initialize defaults
    }
  }

  /**
   * Save current selections to conversation metadata
   */
  async saveToConversation(conversationId: string): Promise<void> {
    if (!this.conversationService) {
      return;
    }

    try {
      // Load existing metadata first to preserve sessionId
      const existingConversation = await this.conversationService.getConversation(conversationId);
      const existingSessionId = existingConversation?.metadata?.chatSettings?.sessionId;

      const metadata = {
        chatSettings: {
          providerId: this.selectedModel?.providerId,
          modelId: this.selectedModel?.modelId,
          agentId: this.selectedAgent?.id,
          workspaceId: this.selectedWorkspaceId,
          contextNotes: this.contextNotesManager.getNotes(),
          sessionId: existingSessionId, // Preserve the session ID
          thinking: this.thinkingSettings
        }
      };

      await this.conversationService.updateConversationMetadata(conversationId, metadata);
    } catch (error) {
      // Failed to save to conversation
    }
  }

  /**
   * Get current selected model (sync - returns null if none selected)
   */
  getSelectedModel(): ModelOption | null {
    return this.selectedModel;
  }

  /**
   * Get current selected model or default (async - fetches default if none selected)
   */
  async getSelectedModelOrDefault(): Promise<ModelOption | null> {
    if (this.selectedModel) {
      return this.selectedModel;
    }

    // Get the default model
    const availableModels = await this.getAvailableModels();
    const defaultModel = await ModelSelectionUtility.findDefaultModelOption(this.app, availableModels);

    return defaultModel;
  }

  /**
   * Get current selected agent
   */
  getSelectedAgent(): AgentOption | null {
    return this.selectedAgent;
  }

  /**
   * Get current system prompt (includes workspace context if set)
   */
  async getCurrentSystemPrompt(): Promise<string | null> {
    return await this.buildSystemPromptWithWorkspace();
  }

  /**
   * Get selected workspace ID
   */
  getSelectedWorkspaceId(): string | null {
    return this.selectedWorkspaceId;
  }

  /**
   * Get workspace context
   */
  getWorkspaceContext(): WorkspaceContext | null {
    return this.workspaceContext;
  }

  /**
   * Handle model selection change
   */
  handleModelChange(model: ModelOption | null): void {
    const previousProvider = this.selectedModel?.providerId || '';
    const newProvider = model?.providerId || '';

    this.selectedModel = model;
    this.events.onModelChanged(model);

    // Notify Nexus lifecycle manager of provider changes
    if (previousProvider !== newProvider) {
      const lifecycleManager = getWebLLMLifecycleManager();
      lifecycleManager.handleProviderChanged(previousProvider, newProvider).catch(() => {
        // Lifecycle manager error handling
      });
    }
  }

  /**
   * Handle agent selection change
   */
  async handleAgentChange(agent: AgentOption | null): Promise<void> {
    this.selectedAgent = agent;
    this.currentSystemPrompt = agent?.systemPrompt || null;

    this.events.onAgentChanged(agent);
    this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
  }

  /**
   * Set workspace context - loads full comprehensive data
   * When a workspace is selected in chat settings, load the same rich data
   * as the #workspace suggester (file structure, sessions, states, etc.)
   */
  async setWorkspaceContext(workspaceId: string, context: WorkspaceContext): Promise<void> {
    this.selectedWorkspaceId = workspaceId;
    this.workspaceContext = context; // Keep basic context for backward compatibility

    // Load full comprehensive workspace data (same as #workspace suggester)
    try {
      const fullWorkspaceData = await this.workspaceIntegration.loadWorkspace(workspaceId);
      if (fullWorkspaceData) {
        this.loadedWorkspaceData = fullWorkspaceData;
      }
    } catch (error) {
      console.error('[ModelAgentManager] Failed to load full workspace data:', error);
      this.loadedWorkspaceData = null;
    }

    // Get session ID from current conversation
    const sessionId = await this.getCurrentSessionId();

    if (sessionId) {
      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, workspaceId);
    }

    this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
  }

  /**
   * Clear workspace context
   */
  async clearWorkspaceContext(): Promise<void> {
    this.selectedWorkspaceId = null;
    this.workspaceContext = null;
    this.loadedWorkspaceData = null;
    this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
  }

  /**
   * Get context notes
   */
  getContextNotes(): string[] {
    return this.contextNotesManager.getNotes();
  }

  /**
   * Set context notes
   */
  async setContextNotes(notes: string[]): Promise<void> {
    this.contextNotesManager.setNotes(notes);
    this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
  }

  /**
   * Add context note
   */
  async addContextNote(notePath: string): Promise<void> {
    if (this.contextNotesManager.addNote(notePath)) {
      this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
    }
  }

  /**
   * Remove context note by index
   */
  async removeContextNote(index: number): Promise<void> {
    if (this.contextNotesManager.removeNote(index)) {
      this.events.onSystemPromptChanged(await this.buildSystemPromptWithWorkspace());
    }
  }

  /**
   * Get thinking settings
   */
  getThinkingSettings(): ThinkingSettings {
    return { ...this.thinkingSettings };
  }

  /**
   * Set thinking settings
   */
  setThinkingSettings(settings: ThinkingSettings): void {
    this.thinkingSettings = { ...settings };
  }

  /**
   * Set message enhancement from suggesters
   */
  setMessageEnhancement(enhancement: MessageEnhancement | null): void {
    this.messageEnhancement = enhancement;
  }

  /**
   * Get current message enhancement
   */
  getMessageEnhancement(): MessageEnhancement | null {
    return this.messageEnhancement;
  }

  /**
   * Clear message enhancement (call after message is sent)
   */
  clearMessageEnhancement(): void {
    this.messageEnhancement = null;
  }

  /**
   * Get available models from validated providers
   */
  async getAvailableModels(): Promise<ModelOption[]> {
    return await ModelSelectionUtility.getAvailableModels(this.app);
  }

  /**
   * Get available agents from agent manager
   */
  async getAvailableAgents(): Promise<AgentOption[]> {
    return await AgentConfigurationUtility.getAvailableAgents(this.app);
  }

  /**
   * Get message options for current selection (includes workspace context)
   */
  async getMessageOptions(): Promise<{
    provider?: string;
    model?: string;
    systemPrompt?: string;
    workspaceId?: string;
    sessionId?: string;
    enableThinking?: boolean;
    thinkingEffort?: 'low' | 'medium' | 'high';
  }> {
    const sessionId = await this.getCurrentSessionId();

    return {
      provider: this.selectedModel?.providerId,
      model: this.selectedModel?.modelId,
      systemPrompt: await this.buildSystemPromptWithWorkspace() || undefined,
      workspaceId: this.selectedWorkspaceId || undefined,
      sessionId: sessionId,
      enableThinking: this.thinkingSettings.enabled,
      thinkingEffort: this.thinkingSettings.effort
    };
  }

  /**
   * Build system prompt with workspace context and dynamic context
   * Dynamic context (vault structure, workspaces, agents) is always fetched fresh
   */
  private async buildSystemPromptWithWorkspace(): Promise<string | null> {
    const sessionId = await this.getCurrentSessionId();

    // Fetch dynamic context (always fresh)
    const vaultStructure = this.workspaceIntegration.getVaultStructure();
    const availableWorkspaces = await this.workspaceIntegration.listAvailableWorkspaces();
    const availableAgents = await this.getAvailableAgentSummaries();
    const toolAgents = this.getToolAgentInfo();

    return await this.systemPromptBuilder.build({
      sessionId,
      workspaceId: this.selectedWorkspaceId || undefined,
      contextNotes: this.contextNotesManager.getNotes(),
      messageEnhancement: this.messageEnhancement,
      agentPrompt: this.currentSystemPrompt,
      workspaceContext: this.workspaceContext,
      loadedWorkspaceData: this.loadedWorkspaceData, // Full comprehensive workspace data
      // Dynamic context (always loaded fresh)
      vaultStructure,
      availableWorkspaces,
      availableAgents,
      toolAgents
    });
  }

  /**
   * Get available agents as AgentSummary for system prompt
   */
  private async getAvailableAgentSummaries(): Promise<AgentSummary[]> {
    const agents = await this.getAvailableAgents();
    return agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || 'Custom agent'
    }));
  }

  /**
   * Get tool agents info from agent registry for system prompt
   * Returns agent names, descriptions, and their available modes
   */
  private getToolAgentInfo(): ToolAgentInfo[] {
    try {
      // Access plugin from app
      const appWithPlugins = this.app as AppWithPlugins;
      const plugin = appWithPlugins.plugins?.plugins?.['claudesidian-mcp'] as unknown as PluginWithSettings | undefined;
      if (!plugin) {
        return [];
      }

      // Try agentRegistrationService first (works on both desktop and mobile)
      const agentService = plugin.serviceManager?.getServiceIfReady?.('agentRegistrationService');
      if (agentService) {
        const agents = agentService.getAllAgents();
        const agentMap = agents instanceof Map ? agents : new Map(agents.map((a: any) => [a.name, a]));

        return Array.from(agentMap.entries()).map(([name, agent]: [string, any]) => {
          const tools = agent.getTools?.() || [];
          return {
            name,
            description: agent.description || '',
            modes: tools.map((t: any) => t.slug || t.name || 'unknown')
          };
        });
      }

      // Fallback to connector's agentRegistry (desktop only)
      const connector = plugin.connector;
      if (connector?.agentRegistry) {
        const agents = connector.agentRegistry.getAllAgents() as Map<string, any>;
        const result: ToolAgentInfo[] = [];

        for (const [name, agent] of agents) {
          const tools = agent.getTools?.() || [];
          result.push({
            name,
            description: agent.description || '',
            modes: tools.map((t: any) => t.slug || t.name || 'unknown')
          });
        }

        return result;
      }

      return [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get current session ID from conversation
   */
  private async getCurrentSessionId(): Promise<string | undefined> {
    if (!this.currentConversationId || !this.conversationService) {
      return undefined;
    }

    try {
      const conversation = await this.conversationService.getConversation(this.currentConversationId);
      return conversation?.metadata?.chatSettings?.sessionId;
    } catch (error) {
      return undefined;
    }
  }
}
