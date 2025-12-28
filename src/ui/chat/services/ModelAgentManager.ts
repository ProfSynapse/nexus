/**
 * ModelAgentManager - Handles model and agent selection, loading, and state management
 * Refactored to use extracted utilities following SOLID principles
 */

import { ModelOption, PromptOption } from '../types/SelectionTypes';
import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { SystemPromptBuilder, PromptSummary, ToolAgentInfo, ContextStatusInfo } from './SystemPromptBuilder';
import { ContextNotesManager } from './ContextNotesManager';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import { PromptConfigurationUtility } from '../utils/PromptConfigurationUtility';
import { WorkspaceIntegrationService } from './WorkspaceIntegrationService';
import { getWebLLMLifecycleManager } from '../../../services/llm/adapters/webllm/WebLLMLifecycleManager';
import { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { ContextTokenTracker, ContextStatus } from '../../../services/chat/ContextTokenTracker';
import { CompactedContext } from '../../../services/chat/ContextCompactionService';
import type NexusPlugin from '../../../main';
import type { App } from 'obsidian';

// Context window sizes for providers that need auto-compaction
// Only WebLLM/Nexus needs this - it crashes on context overflow (WebGPU hard limit)
// Ollama/LM Studio handle overflow gracefully and have variable context sizes
const LOCAL_PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  webllm: 4096,   // Nexus Quark uses 4K context - NEEDS compaction or crashes
  // ollama and lmstudio omitted - they handle overflow gracefully
};

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
      defaultPromptId?: string;
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
  onPromptChanged: (prompt: PromptOption | null) => void;
  onSystemPromptChanged: (systemPrompt: string | null) => void;
}

export class ModelAgentManager {
  private selectedModel: ModelOption | null = null;
  private selectedPrompt: PromptOption | null = null;
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
  private temperature: number = 0.5;
  private contextTokenTracker: ContextTokenTracker | null = null; // For token-limited models
  private previousContext: CompactedContext | null = null; // Context from compacted conversation

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
          chatSettings.promptId ||
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
    const availablePrompts = await this.getAvailablePrompts();

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

    // Restore prompt
    if (settings.promptId) {
      const prompt = availablePrompts.find(p => p.id === settings.promptId);
      if (prompt) {
        this.selectedPrompt = prompt;
        this.currentSystemPrompt = prompt.systemPrompt || null;
        this.events.onPromptChanged(prompt);
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

    // Restore temperature
    if (typeof settings.temperature === 'number') {
      this.temperature = Math.max(0, Math.min(1, settings.temperature));
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
   * Initialize from plugin settings defaults (model, workspace, prompt, thinking)
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
      this.selectedPrompt = null;
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

      // Load default prompt if set
      if (settings?.defaultPromptId) {
        try {
          const availablePrompts = await this.getAvailablePrompts();
          const defaultPrompt = availablePrompts.find(p => p.id === settings.defaultPromptId || p.name === settings.defaultPromptId);
          if (defaultPrompt) {
            this.selectedPrompt = defaultPrompt;
            this.currentSystemPrompt = defaultPrompt.systemPrompt || null;
            this.events.onPromptChanged(defaultPrompt);
            this.events.onSystemPromptChanged(this.currentSystemPrompt);
            return; // Prompt was set, don't reset
          }
        } catch (error) {
          // Failed to load default prompt
        }
      }

      // Notify listeners about the state (no prompt selected)
      this.events.onPromptChanged(null);
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
          promptId: this.selectedPrompt?.id,
          workspaceId: this.selectedWorkspaceId,
          contextNotes: this.contextNotesManager.getNotes(),
          sessionId: existingSessionId, // Preserve the session ID
          thinking: this.thinkingSettings,
          temperature: this.temperature
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
   * Get current selected prompt
   */
  getSelectedPrompt(): PromptOption | null {
    return this.selectedPrompt;
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
   * Get full loaded workspace data (sessions, states, files, etc.)
   * This is the comprehensive data used in system prompts
   */
  getLoadedWorkspaceData(): any {
    return this.loadedWorkspaceData;
  }

  /**
   * Handle model selection change
   */
  handleModelChange(model: ModelOption | null): void {
    const previousProvider = this.selectedModel?.providerId || '';
    const newProvider = model?.providerId || '';

    this.selectedModel = model;
    this.events.onModelChanged(model);

    // Initialize or clear context token tracker based on provider
    this.updateContextTokenTracker(newProvider);

    // Notify Nexus lifecycle manager of provider changes
    if (previousProvider !== newProvider) {
      const lifecycleManager = getWebLLMLifecycleManager();
      lifecycleManager.handleProviderChanged(previousProvider, newProvider).catch(() => {
        // Lifecycle manager error handling
      });
    }
  }

  /**
   * Update context token tracker based on provider
   * Only local providers with limited context windows need tracking
   */
  private updateContextTokenTracker(provider: string): void {
    const contextWindow = LOCAL_PROVIDER_CONTEXT_WINDOWS[provider];

    if (contextWindow) {
      // Initialize or update tracker for local provider
      if (!this.contextTokenTracker) {
        this.contextTokenTracker = new ContextTokenTracker(contextWindow);
      } else {
        this.contextTokenTracker.setMaxTokens(contextWindow);
        this.contextTokenTracker.reset();
      }
    } else {
      // Clear tracker for API providers (they handle context internally)
      this.contextTokenTracker = null;
    }
  }

  /**
   * Handle prompt selection change
   */
  async handlePromptChange(prompt: PromptOption | null): Promise<void> {
    this.selectedPrompt = prompt;
    this.currentSystemPrompt = prompt?.systemPrompt || null;

    this.events.onPromptChanged(prompt);
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
   * Get temperature
   */
  getTemperature(): number {
    return this.temperature;
  }

  /**
   * Set temperature (clamped to 0.0-1.0)
   */
  setTemperature(temperature: number): void {
    this.temperature = Math.max(0, Math.min(1, temperature));
  }

  // ========== Context Token Tracking (for local providers) ==========

  /**
   * Record token usage from a generation response
   * Call this after streaming completes with actual usage data
   */
  recordTokenUsage(promptTokens: number, completionTokens: number): void {
    if (this.contextTokenTracker) {
      this.contextTokenTracker.recordUsage(promptTokens, completionTokens);
    }
  }

  /**
   * Get current context status (for UI display or compaction checks)
   */
  getContextStatus(): ContextStatus | null {
    return this.contextTokenTracker?.getStatus() || null;
  }

  /**
   * Check if message should trigger compaction before sending
   */
  shouldCompactBeforeSending(message: string): boolean {
    return this.contextTokenTracker?.shouldCompactBeforeSending(message) || false;
  }

  /**
   * Reset token tracker (after compaction or new conversation)
   */
  resetTokenTracker(): void {
    this.contextTokenTracker?.reset();
  }

  /**
   * Check if using a token-limited local model
   */
  isUsingLocalModel(): boolean {
    return this.contextTokenTracker !== null;
  }

  /**
   * Get the context token tracker (for direct access if needed)
   */
  getContextTokenTracker(): ContextTokenTracker | null {
    return this.contextTokenTracker;
  }

  // ========== Previous Context (from compaction) ==========

  /**
   * Set previous context from compaction
   * This will be injected into the system prompt as <previous_context>
   */
  setPreviousContext(context: CompactedContext): void {
    this.previousContext = context;
  }

  /**
   * Get the current previous context
   */
  getPreviousContext(): CompactedContext | null {
    return this.previousContext;
  }

  /**
   * Clear previous context (on new conversation or manual clear)
   */
  clearPreviousContext(): void {
    this.previousContext = null;
  }

  /**
   * Check if there is previous context from compaction
   */
  hasPreviousContext(): boolean {
    return this.previousContext !== null && this.previousContext.summary.length > 0;
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
   * Get available prompts from prompt manager
   */
  async getAvailablePrompts(): Promise<PromptOption[]> {
    return await PromptConfigurationUtility.getAvailablePrompts(this.app);
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
    temperature?: number;
  }> {
    const sessionId = await this.getCurrentSessionId();

    return {
      provider: this.selectedModel?.providerId,
      model: this.selectedModel?.modelId,
      systemPrompt: await this.buildSystemPromptWithWorkspace() || undefined,
      workspaceId: this.selectedWorkspaceId || undefined,
      sessionId: sessionId,
      enableThinking: this.thinkingSettings.enabled,
      thinkingEffort: this.thinkingSettings.effort,
      temperature: this.temperature
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
    const availablePrompts = await this.getAvailablePromptSummaries();
    const toolAgents = this.getToolAgentInfo();

    // Skip tools section for Nexus/WebLLM - it's pre-trained on the toolset
    const isNexusModel = this.selectedModel?.providerId === 'webllm';

    // Get context status for token-limited models
    let contextStatus: ContextStatusInfo | null = null;
    if (this.contextTokenTracker) {
      const status = this.contextTokenTracker.getStatus();
      contextStatus = {
        usedTokens: status.usedTokens,
        maxTokens: status.maxTokens,
        percentUsed: status.percentUsed,
        status: status.status,
        statusMessage: this.contextTokenTracker.getStatusForPrompt()
      };
    }

    return await this.systemPromptBuilder.build({
      sessionId,
      workspaceId: this.selectedWorkspaceId || undefined,
      contextNotes: this.contextNotesManager.getNotes(),
      messageEnhancement: this.messageEnhancement,
      customPrompt: this.currentSystemPrompt,
      workspaceContext: this.workspaceContext,
      loadedWorkspaceData: this.loadedWorkspaceData, // Full comprehensive workspace data
      // Dynamic context (always loaded fresh)
      vaultStructure,
      availableWorkspaces,
      availablePrompts,
      toolAgents,
      // Nexus models are pre-trained on the toolset - skip tools section
      skipToolsSection: isNexusModel,
      // Context status for token-limited models
      contextStatus,
      // Previous context from compaction (if any)
      previousContext: this.previousContext
    });
  }

  /**
   * Get available prompts as summaries for system prompt
   * Note: These are user-created prompts, displayed in system prompt for LLM awareness
   */
  private async getAvailablePromptSummaries(): Promise<PromptSummary[]> {
    const prompts = await this.getAvailablePrompts();
    return prompts.map(prompt => ({
      id: prompt.id,
      name: prompt.name,
      description: prompt.description || 'Custom prompt'
    }));
  }

  /**
   * Get tool agents info from agent registry for system prompt
   * Returns agent names, descriptions, and their available tools
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
          const agentTools = agent.getTools?.() || [];
          return {
            name,
            description: agent.description || '',
            tools: agentTools.map((t: any) => t.slug || t.name || 'unknown')
          };
        });
      }

      // Fallback to connector's agentRegistry (desktop only)
      const connector = plugin.connector;
      if (connector?.agentRegistry) {
        const agents = connector.agentRegistry.getAllAgents() as Map<string, any>;
        const result: ToolAgentInfo[] = [];

        for (const [name, agent] of agents) {
          const agentTools = agent.getTools?.() || [];
          result.push({
            name,
            description: agent.description || '',
            tools: agentTools.map((t: any) => t.slug || t.name || 'unknown')
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
