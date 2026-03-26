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
import { getNexusPlugin } from '../../../utils/pluginLocator';
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

interface ConversationChatSettings {
  providerId?: string;
  modelId?: string;
  promptId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  contextNotes?: string[];
  agentProvider?: string | null;
  agentModel?: string | null;
  agentThinking?: ThinkingSettings;
  thinking?: ThinkingSettings;
  temperature?: number;
}

interface ConversationMetadataWithCompaction extends Record<string, unknown> {
  chatSettings?: ConversationChatSettings;
  compaction?: ConversationCompactionMetadata;
}

interface ConversationRecordLike {
  metadata?: ConversationMetadataWithCompaction;
}

interface ConversationServiceLike {
  getConversation(conversationId: string): Promise<ConversationRecordLike | null>;
  updateConversationMetadata(conversationId: string, metadata: Record<string, unknown>): Promise<void>;
}

interface AgentLike {
  description?: unknown;
  getTools?: () => unknown;
}

interface AgentRegistryLike {
  getAllAgents: () => unknown;
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
  serviceManager?: {
    getServiceIfReady?: (name: string) => unknown;
  };
  connector?: {
    agentRegistry?: AgentRegistryLike;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPluginWithSettings(value: unknown): value is PluginWithSettings {
  return isRecord(value);
}

function isAgentRegistryLike(value: unknown): value is AgentRegistryLike {
  return isRecord(value) && typeof value.getAllAgents === 'function';
}

function isNamedAgent(value: unknown): value is AgentLike & { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}

function isAgentLike(value: unknown): value is AgentLike {
  return isRecord(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isWorkspaceContext(value: unknown): value is WorkspaceContext {
  return isRecord(value);
}

function getWorkspaceContextProperty(record: Record<string, unknown>, key: string): WorkspaceContext | undefined {
  const value = record[key];
  return isWorkspaceContext(value) ? value : undefined;
}

function getAgentToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.map((tool): string => {
    if (!isRecord(tool)) {
      return 'unknown';
    }

    return typeof tool.slug === 'string' && tool.slug.length > 0
      ? tool.slug
      : typeof tool.name === 'string' && tool.name.length > 0
        ? tool.name
        : 'unknown';
  });
}

function normalizeAgentEntries(agents: unknown): Array<[string, AgentLike]> {
  if (agents instanceof Map) {
    return Array.from(agents.entries()).flatMap(([name, agent]) => {
      if (typeof name !== 'string' || !isAgentLike(agent)) {
        return [];
      }

      return [[name, agent]];
    });
  }

  if (Array.isArray(agents)) {
    return agents.flatMap(agent => {
      if (!isNamedAgent(agent)) {
        return [];
      }

      return [[agent.name, agent]];
    });
  }

  if (isRecord(agents)) {
    return Object.entries(agents).flatMap(([name, agent]) => {
      if (!isAgentLike(agent)) {
        return [];
      }

      return [[name, agent]];
    });
  }

  return [];
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
  private loadedWorkspaceData: Record<string, unknown> | null = null; // Full comprehensive workspace data from LoadWorkspaceTool
  private contextNotesManager: ContextNotesManager;
  private currentConversationId: string | null = null;
  private messageEnhancement: MessageEnhancement | null = null;
  private systemPromptBuilder: SystemPromptBuilder;
  private workspaceIntegration: WorkspaceIntegrationService;
  private agentProvider: string | null = null;
  private agentModel: string | null = null;
  private agentThinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };
  private thinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };
  private temperature: number = 0.5;
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
      let chatSettings: ConversationChatSettings | undefined;
      let conversationMetadata: ConversationMetadataWithCompaction | undefined;

      if (this.conversationService) {
        const conversation = await this.conversationService.getConversation(conversationId);
        conversationMetadata = conversation?.metadata;
        chatSettings = conversation?.metadata?.chatSettings;
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

  private hasStoredChatSettings(settings: ConversationChatSettings | undefined): boolean {
    if (!settings) {
      return false;
    }

    return Object.keys(settings).length > 0;
  }

  /**
   * Restore settings from conversation metadata
   */
  private async restoreFromConversationMetadata(settings: ConversationChatSettings): Promise<void> {
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
        await this.restoreWorkspace(settings.workspaceId, settings.sessionId);
      } else {
        this.selectedWorkspaceId = null;
        this.workspaceContext = null;
        this.loadedWorkspaceData = null;
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
   * Restore workspace from settings - loads full comprehensive data
   */
  private async restoreWorkspace(workspaceId: string, sessionId?: string): Promise<void> {
    try {
      // Load full comprehensive workspace data (same as #workspace suggester)
      const fullWorkspaceData = await this.workspaceIntegration.loadWorkspace(workspaceId);

      if (!fullWorkspaceData) {
        this.selectedWorkspaceId = null;
        this.loadedWorkspaceData = null;
        this.workspaceContext = null;
        return;
      }

      this.selectedWorkspaceId = getStringProperty(fullWorkspaceData, 'id') || workspaceId;

      this.loadedWorkspaceData = fullWorkspaceData;
      // Also extract basic context for backward compatibility
      this.workspaceContext =
        getWorkspaceContextProperty(fullWorkspaceData, 'context') ||
        getWorkspaceContextProperty(fullWorkspaceData, 'workspaceContext') ||
        null;

      // Bind session to workspace
      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, this.selectedWorkspaceId);
    } catch (error) {
      console.error('[ModelAgentManager] Failed to restore workspace:', error);
      // Clear workspace data on failure
      this.selectedWorkspaceId = null;
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
      this.contextNotesManager.clear();
      this.agentProvider = null;
      this.agentModel = null;
      this.agentThinkingSettings = { enabled: false, effort: 'medium' };

      // Get plugin settings for defaults
      const plugin = this.getPluginWithSettings();
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
      if (isStringArray(settings?.defaultContextNotes)) {
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
    conversation: ConversationData,
    message: string,
    systemPrompt?: string | null,
    providerOverride?: string
  ): boolean {
    const provider = providerOverride || this.selectedModel?.providerId || null;
    const budget = ContextBudgetService.estimateBudget(
      provider,
      conversation,
      systemPrompt,
      message
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
      this.getFrontierFromMetadata(metadata),
      compactionRecord
    );
    return this.buildMetadataWithCompactionFrontier(metadata, frontier);
  }

  buildMetadataWithCompactionFrontier(
    metadata: Record<string, unknown> | undefined,
    frontier: CompactedContext[]
  ): Record<string, unknown> {
    const existingMetadata = { ...(metadata ?? {}) };
    const existingCompaction = this.getCompactionSection(metadata);
    const remainingCompaction = { ...(existingCompaction ?? {}) };
    delete remainingCompaction.previousContext;
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
    metadata: Record<string, unknown> | undefined
  ): CompactionFrontierRecord[] {
    const frontier = this.getCompactionSection(metadata)?.frontier;
    if (Array.isArray(frontier)) {
      return this.compactionFrontierService.normalizeFrontier(
        frontier.filter(this.isValidCompactedContext)
      );
    }

    const legacyCompactionRecord = this.getCompactionSection(metadata)?.previousContext;
    if (this.isValidCompactedContext(legacyCompactionRecord)) {
      return this.compactionFrontierService.normalizeFrontier([legacyCompactionRecord]);
    }

    return [];
  }

  private getCompactionSection(metadata: Record<string, unknown> | undefined): ConversationCompactionMetadata | null {
    const compaction = metadata?.compaction;
    if (!isRecord(compaction)) {
      return null;
    }

    const result: ConversationCompactionMetadata = {};

    if (Array.isArray(compaction.frontier)) {
      result.frontier = compaction.frontier.filter(this.isValidCompactedContext);
    }

    if (this.isValidCompactedContext(compaction.previousContext)) {
      result.previousContext = compaction.previousContext;
    }

    return result;
  }

  private isValidCompactedContext = (
    value: unknown
  ): value is CompactedContext => {
    return isRecord(value) &&
      typeof value.summary === 'string' &&
      value.summary.length > 0;
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
      const plugin = this.getPluginWithSettings();
      if (!plugin) {
        return [];
      }

      // Try agentRegistrationService first (works on both desktop and mobile)
      const agentService = plugin.serviceManager?.getServiceIfReady?.('agentRegistrationService');
      if (isAgentRegistryLike(agentService)) {
        return this.mapToolAgents(normalizeAgentEntries(agentService.getAllAgents()));
      }

      // Fallback to connector's agentRegistry (desktop only)
      const connector = plugin.connector;
      if (connector?.agentRegistry) {
        return this.mapToolAgents(normalizeAgentEntries(connector.agentRegistry.getAllAgents()));
      }

      return [];
    } catch {
      return [];
    }
  }

  private getPluginWithSettings(): PluginWithSettings | null {
    const plugin = getNexusPlugin(this.app);
    return isPluginWithSettings(plugin) ? plugin : null;
  }

  private mapToolAgents(agents: Array<[string, AgentLike]>): ToolAgentInfo[] {
    return agents.map(([name, agent]) => {
      const agentTools = agent.getTools?.();

      return {
        name,
        description: typeof agent.description === 'string' ? agent.description : '',
        tools: getAgentToolNames(agentTools)
      };
    });
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
