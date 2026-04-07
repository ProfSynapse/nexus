/**
 * ModelAgentManager - Handles model and agent selection, loading, and state management
 * Refactored to use extracted utilities following SOLID principles
 */

import { ModelOption, PromptOption } from '../types/SelectionTypes';
import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { SystemPromptBuilder, ContextStatusInfo } from './SystemPromptBuilder';
import { ContextNotesManager } from './ContextNotesManager';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import { PromptConfigurationUtility } from '../utils/PromptConfigurationUtility';
import { WorkspaceIntegrationService } from './WorkspaceIntegrationService';
import { StaticModelsService } from '../../../services/StaticModelsService';
import { getWebLLMLifecycleManager } from '../../../services/llm/adapters/webllm/WebLLMLifecycleManager';
import { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { ContextTokenTracker, ContextStatus } from '../../../services/chat/ContextTokenTracker';
import { CompactedContext } from '../../../services/chat/ContextCompactionService';
import {
  CompactionFrontierBudgetPolicy,
  CompactionFrontierRecord,
  CompactionFrontierService
} from '../../../services/chat/CompactionFrontierService';
import { ContextBudgetService } from '../../../services/chat/ContextBudgetService';
import { ConversationData } from '../../../types/chat/ChatTypes';
import type NexusPlugin from '../../../main';
import type { App } from 'obsidian';

// Context window sizes for providers that participate in app-level pre-send compaction.
// WebLLM uses a small hard-ish limit; selected CLI/API-backed providers use a conservative
// 200k soft cap so long-running conversations compact before provider-side overflow/degradation.
const LOCAL_PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  webllm: 4096,   // Nexus Quark uses 4K context - NEEDS compaction or crashes
  'anthropic-claude-code': 200000,
  'google-gemini-cli': 200000,
  'openai-codex': 200000,
  'github-copilot': 200000,
  // ollama and lmstudio omitted - they handle overflow gracefully
};

const PRE_SEND_ESTIMATE_MULTIPLIERS: Record<string, number> = {
  'anthropic-claude-code': 1.15,
  'google-gemini-cli': 1.15,
  'openai-codex': 1.15,
  'github-copilot': 1.15
};

interface ConversationCompactionMetadata {
  // Legacy single-record metadata still restored for backward compatibility.
  previousContext?: CompactedContext;
  frontier?: CompactionFrontierRecord[];
}

interface ConversationMetadataWithCompaction {
  chatSettings?: {
    providerId?: string;
    modelId?: string;
    promptId?: string;
    workspaceId?: string;
    sessionId?: string;
  };
  compaction?: ConversationCompactionMetadata;
  [key: string]: unknown;
}

interface ConversationSettingsMetadata {
  providerId?: string;
  modelId?: string;
  promptId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  contextNotes?: string[];
  thinking?: ThinkingSettings;
  temperature?: number;
  agentProvider?: string | null;
  agentModel?: string | null;
  agentThinking?: ThinkingSettings;
}

interface ConversationServiceLike {
  getConversation(conversationId: string, pagination?: { page?: number; pageSize?: number }): Promise<{
    metadata?: ConversationMetadataWithCompaction & {
      chatSettings?: ConversationSettingsMetadata;
    };
  } | null>;
  updateConversationMetadata(conversationId: string, metadata: Record<string, unknown>): Promise<void>;
}

/**
 * Plugin interface with settings structure
 */
interface PluginWithSettings {
  settings?: {
    settings?: {
      llmProviders?: {
        defaultThinking?: ThinkingSettings;
        defaultTemperature?: number;
        agentModel?: { provider: string; model: string };
        agentThinking?: ThinkingSettings;
      };
      defaultWorkspaceId?: string;
      defaultPromptId?: string;
      defaultContextNotes?: string[];
    };
  };
}

export interface ModelAgentManagerEvents {
  onModelChanged: (model: ModelOption | null) => void;
  onPromptChanged: (prompt: PromptOption | null) => void;
  onSystemPromptChanged: (systemPrompt: string | null) => void;
}

export class ModelAgentManager {
  static readonly COMPACTION_FRONTIER_CAP = CompactionFrontierService.DEFAULT_POLICY.maxRecords;
  private staticModelsService = StaticModelsService.getInstance();
  private selectedModel: ModelOption | null = null;
  private selectedPrompt: PromptOption | null = null;
  private currentSystemPrompt: string | null = null;
  private selectedWorkspaceId: string | null = null;
  private workspaceContext: WorkspaceContext | null = null;
  private loadedWorkspaceData: Record<string, unknown> | null = null;  // Full data — populated on first-message send, cleared immediately after
  private pendingFullWorkspaceLoad = false;                            // True from workspace selection/restore until first message is sent
  private selectedWorkspaceSlimData: {                                 // Slim header data — always populated when workspace selected
    id: string;
    name: string;
    description?: string;
    purpose?: string;
    rootFolder?: string;
  } | null = null;
  private contextNotesManager: ContextNotesManager;
  private currentConversationId: string | null = null;
  private messageEnhancement: MessageEnhancement | null = null;
  private systemPromptBuilder: SystemPromptBuilder;
  private workspaceIntegration: WorkspaceIntegrationService;
  private agentProvider: string | null = null;
  private agentModel: string | null = null;
  private agentThinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };
  private thinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };
  private temperature = 0.5;
  private contextTokenTracker: ContextTokenTracker | null = null; // For token-limited models
  private compactionFrontier: CompactionFrontierRecord[] = []; // Active bounded compaction frontier
  private compactionFrontierService = new CompactionFrontierService();

  constructor(
    private app: App, // Obsidian App
    private events: ModelAgentManagerEvents,
    private conversationService?: ConversationServiceLike, // Optional ConversationService for persistence
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
    this.clearCompactionFrontier();
    await this.initializeDefaultModel();
  }

  /**
   * Initialize from conversation metadata (if available), otherwise use plugin default
   */
  async initializeFromConversation(conversationId: string): Promise<void> {
    try {
      let chatSettings: ConversationSettingsMetadata | undefined;
      let conversationMetadata: ConversationMetadataWithCompaction | undefined;

      if (this.conversationService) {
        const conversation = await this.conversationService.getConversation(conversationId);
        conversationMetadata = conversation?.metadata as ConversationMetadataWithCompaction | undefined;
        chatSettings = conversation?.metadata?.chatSettings as ConversationSettingsMetadata | undefined;
      }

      this.clearCompactionFrontier();
      await this.initializeDefaultModel();
      this.restoreCompactionFrontierFromMetadata(conversationMetadata);

      if (this.hasStoredChatSettings(chatSettings)) {
        await this.restoreFromConversationMetadata(chatSettings);
      }
    } catch {
      this.clearCompactionFrontier();
      await this.initializeDefaultModel();
    }
  }

  private hasStoredChatSettings(settings: ConversationSettingsMetadata | undefined): boolean {
    if (!settings) {
      return false;
    }

    return Object.keys(settings).length > 0;
  }

  /**
   * Restore settings from conversation metadata
   */
  private async restoreFromConversationMetadata(settings: ConversationSettingsMetadata | undefined): Promise<void> {
    if (!settings) {
      return;
    }
    // Restore model
    if (settings.providerId && settings.modelId) {
      try {
        const model = await this.resolveModelOption(settings.providerId, settings.modelId);

        if (model) {
          this.selectedModel = model;
          this.updateCompactionFrontierPolicy(model);
          this.events.onModelChanged(model);
        } else {
          await this.initializeDefaultModel();
        }
      } catch (error) {
        console.error('[ModelAgentManager] Failed to restore chat model:', error);
      }
    }

    // Restore prompt
    if ('promptId' in settings) {
      if (!settings.promptId) {
        this.selectedPrompt = null;
        this.currentSystemPrompt = null;
        this.events.onPromptChanged(null);
        this.events.onSystemPromptChanged(null);
      } else {
        try {
          const availablePrompts = await this.getAvailablePrompts();
          const prompt = availablePrompts.find(p => p.id === settings.promptId || p.name === settings.promptId);
          if (prompt) {
            this.selectedPrompt = prompt;
            this.currentSystemPrompt = prompt.systemPrompt || null;
            this.events.onPromptChanged(prompt);
          }
        } catch (error) {
          console.error('[ModelAgentManager] Failed to restore prompt selection:', error);
        }
      }
    }

    // Restore workspace
    if ('workspaceId' in settings) {
      if (settings.workspaceId) {
        await this.restoreWorkspace(settings.workspaceId, settings.sessionId ?? undefined);
      } else {
        this.selectedWorkspaceId = null;
        this.workspaceContext = null;
        this.loadedWorkspaceData = null;
        this.pendingFullWorkspaceLoad = false;
        this.selectedWorkspaceSlimData = null;
      }
    }

    // Restore context notes
    if ('contextNotes' in settings) {
      this.contextNotesManager.setNotes(Array.isArray(settings.contextNotes) ? settings.contextNotes : []);
    }

    // Restore agent model
    if ('agentProvider' in settings || 'agentModel' in settings) {
      this.agentProvider = settings.agentProvider || null;
      this.agentModel = settings.agentModel || null;
    }

    // Restore agent thinking settings
    if ('agentThinking' in settings && settings.agentThinking) {
      this.agentThinkingSettings = {
        enabled: settings.agentThinking.enabled ?? false,
        effort: settings.agentThinking.effort ?? 'medium'
      };
    }

    // Restore thinking settings
    if ('thinking' in settings && settings.thinking) {
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
   * Restore workspace from saved conversation metadata.
   * Uses a cheap DB lookup instead of the full loadWorkspace agent call so this
   * is safe to run at startup and on every conversation switch, regardless of
   * agent readiness. selectedWorkspaceId is tentatively set before the await so
   * the modal shows the correct selection even if the fetch fails.
   */
  private async restoreWorkspace(workspaceId: string, sessionId?: string): Promise<void> {
    // Set tentative state immediately — prevents modal from showing empty on transient errors
    this.selectedWorkspaceId = workspaceId;
    this.loadedWorkspaceData = null;
    this.pendingFullWorkspaceLoad = false;
    this.workspaceContext = null;
    this.selectedWorkspaceSlimData = null;

    try {
      const workspace = await this.workspaceIntegration.getWorkspaceBasic(workspaceId);

      if (!workspace) {
        // Workspace genuinely absent from DB — clear selection
        this.selectedWorkspaceId = null;
        return;
      }

      this.selectedWorkspaceId = workspace.id;
      this.workspaceContext = (workspace.context as WorkspaceContext) || null;
      this.selectedWorkspaceSlimData = {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        purpose: workspace.context?.['purpose'] as string | undefined,
        rootFolder: workspace.rootFolder
      };
      this.pendingFullWorkspaceLoad = true; // Full load fires on first message send (G-W3)

      // Bind session to workspace
      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, this.selectedWorkspaceId);
    } catch (error) {
      console.error('[ModelAgentManager] Failed to restore workspace:', error);
      // Keep tentative selectedWorkspaceId — do not wipe on transient DB errors
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
        this.updateCompactionFrontierPolicy(defaultModel);
        this.events.onModelChanged(defaultModel);
      } else {
        this.updateCompactionFrontierPolicy(null);
      }

      // Clear state first
      this.selectedPrompt = null;
      this.currentSystemPrompt = null;
      this.selectedWorkspaceId = null;
      this.workspaceContext = null;
      this.loadedWorkspaceData = null;
      this.pendingFullWorkspaceLoad = false;
      this.selectedWorkspaceSlimData = null;
      this.contextNotesManager.clear();
      this.agentProvider = null;
      this.agentModel = null;
      this.agentThinkingSettings = { enabled: false, effort: 'medium' };

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

      // Load default agent model if set
      if (llmProviders?.agentModel) {
        this.agentProvider = llmProviders.agentModel.provider || null;
        this.agentModel = llmProviders.agentModel.model || null;
      }

      // Load default agent thinking settings if set
      if (llmProviders?.agentThinking) {
        this.agentThinkingSettings = {
          enabled: llmProviders.agentThinking.enabled ?? false,
          effort: llmProviders.agentThinking.effort ?? 'medium'
        };
      }

      // Load default temperature if set
      if (llmProviders?.defaultTemperature !== undefined) {
        this.temperature = llmProviders.defaultTemperature;
      }

      // Load default context notes if set
      if (settings?.defaultContextNotes && Array.isArray(settings.defaultContextNotes)) {
        this.contextNotesManager.setNotes(settings.defaultContextNotes);
      }

      // Load default workspace if set
      if (settings?.defaultWorkspaceId) {
        try {
          await this.restoreWorkspace(settings.defaultWorkspaceId, undefined);
        } catch {
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
        } catch {
          // Failed to load default prompt
        }
      }

      // Notify listeners about the state (no prompt selected)
      this.events.onPromptChanged(null);
      this.events.onSystemPromptChanged(null);
    } catch {
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
          promptId: this.selectedPrompt?.id ?? null,
          workspaceId: this.selectedWorkspaceId,
          contextNotes: this.contextNotesManager.getNotes(),
          sessionId: existingSessionId, // Preserve the session ID
          thinking: this.thinkingSettings,
          temperature: this.temperature,
          agentProvider: this.agentProvider,
          agentModel: this.agentModel,
          agentThinking: this.agentThinkingSettings
        }
      };

      await this.conversationService.updateConversationMetadata(conversationId, metadata);
    } catch {
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
   * Resolve a provider/model pair to a ModelOption.
   * Falls back to static registry data, then to a minimal placeholder option
   * so per-conversation model settings are not silently lost when discovery is incomplete.
   */
  async resolveModelOption(providerId: string, modelId: string): Promise<ModelOption | null> {
    if (!providerId || !modelId) {
      return null;
    }

    const availableModels = await this.getAvailableModels();
    const discoveredModel = availableModels.find(
      model => model.providerId === providerId && model.modelId === modelId
    );
    if (discoveredModel) {
      return discoveredModel;
    }

    const staticModel = this.staticModelsService.findModel(providerId, modelId);
    if (staticModel) {
      return {
        providerId,
        providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
        modelId,
        modelName: staticModel.name,
        contextWindow: staticModel.contextWindow,
        supportsThinking: staticModel.capabilities.supportsThinking
      };
    }

    return {
      providerId,
      providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
      modelId,
      modelName: modelId,
      contextWindow: 128000,
      supportsThinking: false
    };
  }

  /**
   * Resolve and apply a provider/model selection.
   */
  async setSelectedModelById(providerId: string, modelId: string): Promise<void> {
    const model = await this.resolveModelOption(providerId, modelId);
    this.handleModelChange(model);
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
  getLoadedWorkspaceData(): Record<string, unknown> | null {
    return this.loadedWorkspaceData;
  }

  /**
   * Handle model selection change
   */
  handleModelChange(model: ModelOption | null): void {
    const previousProvider = this.selectedModel?.providerId || '';
    const newProvider = model?.providerId || '';

    this.selectedModel = model;
    this.updateCompactionFrontierPolicy(model);
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
    const preSendEstimateMultiplier = PRE_SEND_ESTIMATE_MULTIPLIERS[provider] ?? 1;

    if (contextWindow) {
      // Initialize or update tracker for local provider
      if (!this.contextTokenTracker) {
        this.contextTokenTracker = new ContextTokenTracker(contextWindow, preSendEstimateMultiplier);
      } else {
        this.contextTokenTracker.setMaxTokens(contextWindow);
        this.contextTokenTracker.setPreSendEstimateMultiplier(preSendEstimateMultiplier);
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
   * Set workspace context when user selects a workspace in chat settings.
   * Populates slim header data via cheap DB lookup; full data is loaded on
   * first message send (G-W3).
   */
  async setWorkspaceContext(workspaceId: string): Promise<void> {
    this.selectedWorkspaceId = workspaceId;
    this.loadedWorkspaceData = null;
    this.pendingFullWorkspaceLoad = false;

    try {
      const slim = await this.workspaceIntegration.getWorkspaceBasic(workspaceId);
      if (slim) {
        this.workspaceContext = (slim.context as WorkspaceContext) ?? null;
        this.selectedWorkspaceSlimData = {
          id: slim.id,
          name: slim.name,
          description: slim.description,
          purpose: slim.context?.['purpose'] as string | undefined,
          rootFolder: slim.rootFolder
        };
        this.pendingFullWorkspaceLoad = true; // Full load fires on first message send (G-W3)
      } else {
        this.workspaceContext = null;
        this.selectedWorkspaceSlimData = null;
      }
    } catch (error) {
      console.error('[ModelAgentManager] Failed to load workspace slim data:', error);
      this.workspaceContext = null;
      this.selectedWorkspaceSlimData = null;
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
    this.pendingFullWorkspaceLoad = false;
    this.selectedWorkspaceSlimData = null;
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
   * Get agent provider
   */
  getAgentProvider(): string | null {
    return this.agentProvider;
  }

  /**
   * Get agent model
   */
  getAgentModel(): string | null {
    return this.agentModel;
  }

  /**
   * Set agent model (provider and model)
   */
  setAgentModel(provider: string | null, model: string | null): void {
    this.agentProvider = provider;
    this.agentModel = model;
  }

  /**
   * Get agent thinking settings
   */
  getAgentThinkingSettings(): ThinkingSettings {
    return { ...this.agentThinkingSettings };
  }

  /**
   * Set agent thinking settings
   */
  setAgentThinkingSettings(settings: ThinkingSettings): void {
    this.agentThinkingSettings = { ...settings };
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

  // ========== Context Token Tracking (status display for WebLLM) ==========

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
  shouldCompactBeforeSending(
    conversationOrMessage: ConversationData | string,
    message?: string,
    systemPrompt?: string | null,
    providerOverride?: string
  ): boolean {
    const messageText = typeof conversationOrMessage === 'string'
      ? conversationOrMessage
      : (message || '');

    if (this.contextTokenTracker) {
      return this.contextTokenTracker.shouldCompactBeforeSending(messageText);
    }

    if (typeof conversationOrMessage === 'string') {
      return false;
    }

    const provider = providerOverride || this.selectedModel?.providerId || null;
    const budget = ContextBudgetService.estimateBudget(
      provider,
      conversationOrMessage,
      systemPrompt,
      messageText
    );

    return budget.shouldCompact;
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

  // ========== Compaction Frontier ==========

  /**
   * Append a compaction record to the bounded frontier.
   */
  appendCompactionRecord(context: CompactedContext): void {
    this.compactionFrontier = this.compactionFrontierService.appendRecord(this.compactionFrontier, context);
  }

  private updateCompactionFrontierPolicy(model: ModelOption | null): void {
    const policy = CompactionFrontierService.createPolicyForContextWindow(model?.contextWindow);
    this.compactionFrontierService = new CompactionFrontierService(policy);
    this.compactionFrontier = this.compactionFrontierService.normalizeFrontier(this.compactionFrontier);
  }

  getCompactionFrontierBudgetPolicy(): CompactionFrontierBudgetPolicy {
    return CompactionFrontierService.createPolicyForContextWindow(this.selectedModel?.contextWindow);
  }

  /**
   * Append a record to metadata-backed frontier and return updated metadata.
   */
  buildMetadataWithCompactionRecord(
    metadata: Record<string, unknown> | undefined,
    compactionRecord: CompactedContext
  ): Record<string, unknown> {
    const frontier = this.compactionFrontierService.appendRecord(
      this.getFrontierFromMetadata((metadata ?? {}) as ConversationMetadataWithCompaction),
      compactionRecord
    );
    return this.buildMetadataWithCompactionFrontier(metadata, frontier);
  }

  buildMetadataWithCompactionFrontier(
    metadata: Record<string, unknown> | undefined,
    frontier: CompactedContext[]
  ): Record<string, unknown> {
    const existingMetadata = (metadata ?? {}) as ConversationMetadataWithCompaction;
    const existingCompaction = existingMetadata.compaction ?? {};
    const { previousContext: _legacyPreviousContext, ...remainingCompaction } = existingCompaction;
    void _legacyPreviousContext;
    const normalizedFrontier = this.compactionFrontierService.normalizeFrontier(frontier);

    return {
      ...existingMetadata,
      compaction: {
        ...remainingCompaction,
        frontier: normalizedFrontier
      }
    };
  }

  /**
   * Get the latest active compaction record.
   */
  getLatestCompactionRecord(): CompactedContext | null {
    return this.compactionFrontier.length > 0
      ? this.compactionFrontier[this.compactionFrontier.length - 1]
      : null;
  }

  /**
   * Get the current active compaction frontier.
   */
  getCompactionFrontier(): CompactionFrontierRecord[] {
    return [...this.compactionFrontier];
  }

  /**
   * Clear compaction frontier (on new conversation or manual clear)
   */
  clearCompactionFrontier(): void {
    this.compactionFrontier = [];
  }

  /**
   * Check if there is compacted context in the frontier.
   */
  hasCompactionFrontier(): boolean {
    return this.compactionFrontier.some(record => record.summary.length > 0);
  }

  private restoreCompactionFrontierFromMetadata(
    metadata: ConversationMetadataWithCompaction | undefined
  ): void {
    this.compactionFrontier = this.getFrontierFromMetadata(metadata);
  }

  private getFrontierFromMetadata(
    metadata: ConversationMetadataWithCompaction | undefined
  ): CompactionFrontierRecord[] {
    const frontier = metadata?.compaction?.frontier;
    if (Array.isArray(frontier)) {
      return this.compactionFrontierService.normalizeFrontier(
        frontier.filter(this.isValidCompactedContext)
      );
    }

    const legacyCompactionRecord = metadata?.compaction?.previousContext;
    if (this.isValidCompactedContext(legacyCompactionRecord)) {
      return this.compactionFrontierService.normalizeFrontier([legacyCompactionRecord]);
    }

    return [];
  }

  private isValidCompactedContext = (
    value: unknown
  ): value is CompactedContext => {
    return !!value &&
      typeof value === 'object' &&
      typeof (value as CompactedContext).summary === 'string' &&
      (value as CompactedContext).summary.length > 0;
  };

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
    // Clear previous turn's full data before deciding whether to load new data.
    // This keeps loadedWorkspaceData available to subagents throughout the current
    // message-processing cycle (they call getLoadedWorkspaceData() after the send
    // returns), and ensures it doesn't bleed into subsequent turns' system prompts.
    this.loadedWorkspaceData = null;

    // G-W3: on first message after workspace selection/restore, load full data for this turn only
    if (this.pendingFullWorkspaceLoad && this.selectedWorkspaceId) {
      this.pendingFullWorkspaceLoad = false;
      try {
        const fullData = await this.workspaceIntegration.loadWorkspace(this.selectedWorkspaceId);
        if (fullData) {
          this.loadedWorkspaceData = fullData;
        }
      } catch (error) {
        console.error('[ModelAgentManager] First-message workspace load failed, using slim header:', error);
      }
    }

    const sessionId = await this.getCurrentSessionId();
    const systemPrompt = await this.buildSystemPromptWithWorkspace() || undefined;

    return {
      provider: this.selectedModel?.providerId,
      model: this.selectedModel?.modelId,
      systemPrompt,
      workspaceId: this.selectedWorkspaceId || undefined,
      sessionId: sessionId,
      enableThinking: this.thinkingSettings.enabled,
      thinkingEffort: this.thinkingSettings.effort,
      temperature: this.temperature
    };
  }

  /**
   * Build system prompt with workspace context and dynamic context
   */
  private async buildSystemPromptWithWorkspace(): Promise<string | null> {
    const sessionId = await this.getCurrentSessionId();

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
      loadedWorkspaceData: this.loadedWorkspaceData,       // null except on first-message send (G-W3)
      selectedWorkspaceSlimData: this.selectedWorkspaceSlimData,
      // Nexus models are pre-trained on the toolset - skip tools section
      skipToolsSection: isNexusModel,
      // Context status for token-limited models
      contextStatus,
      // Active compaction frontier (if any), plus legacy single-record fallback for older callers
      compactionFrontier: this.compactionFrontier,
      legacyCompactionRecord: this.getLatestCompactionRecord()
    });
  }

  /**
   * @deprecated Use appendCompactionRecord().
   */
  setPreviousContext(context: CompactedContext): void {
    this.appendCompactionRecord(context);
  }

  /**
   * @deprecated Use buildMetadataWithCompactionRecord().
   */
  buildMetadataWithPreviousContext(
    metadata: Record<string, unknown> | undefined,
    previousContext: CompactedContext
  ): Record<string, unknown> {
    return this.buildMetadataWithCompactionRecord(metadata, previousContext);
  }

  /**
   * @deprecated Use getLatestCompactionRecord().
   */
  getPreviousContext(): CompactedContext | null {
    return this.getLatestCompactionRecord();
  }

  /**
   * @deprecated Use clearCompactionFrontier().
   */
  clearPreviousContext(): void {
    this.clearCompactionFrontier();
  }

  /**
   * @deprecated Use hasCompactionFrontier().
   */
  hasPreviousContext(): boolean {
    return this.hasCompactionFrontier();
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
    } catch {
      return undefined;
    }
  }
}
