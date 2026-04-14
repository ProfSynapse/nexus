/**
 * ModelAgentManager - Handles model and agent selection, loading, and state management
 * Refactored to use extracted utilities following SOLID principles
 */

import { ModelOption, PromptOption } from '../types/SelectionTypes';
import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { SystemPromptBuilder } from './SystemPromptBuilder';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { AgentManager } from '../../../services/AgentManager';
import type { IAgent } from '../../../agents/interfaces/IAgent';
import { ContextNotesManager } from './ContextNotesManager';
import {
  ModelAgentConversationSettingsStore,
  type ConversationMetadataWithCompaction,
  type ConversationServiceLike,
  type ConversationSettingsMetadata,
} from './ModelAgentConversationSettingsStore';
import { ModelAgentWorkspaceContextService } from './ModelAgentWorkspaceContextService';
import { ModelAgentDefaultsResolver } from './ModelAgentDefaultsResolver';
import { ModelAgentCompactionState } from './ModelAgentCompactionState';
import {
  ModelAgentPromptContextAssembler,
  type ModelAgentMessageOptions,
  type ModelAgentPromptContextSnapshot,
} from './ModelAgentPromptContextAssembler';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import { PromptConfigurationUtility } from '../utils/PromptConfigurationUtility';
import { WorkspaceIntegrationService } from './WorkspaceIntegrationService';
import { StaticModelsService } from '../../../services/StaticModelsService';
import { getWebLLMLifecycleManager } from '../../../services/llm/adapters/webllm/WebLLMLifecycleManager';
import { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { ContextStatus, ContextTokenTracker } from '../../../services/chat/ContextTokenTracker';
import { CompactedContext } from '../../../services/chat/ContextCompactionService';
import {
  CompactionFrontierBudgetPolicy,
  CompactionFrontierRecord,
  CompactionFrontierService
} from '../../../services/chat/CompactionFrontierService';
import { ConversationData } from '../../../types/chat/ChatTypes';
import type { App } from 'obsidian';

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
  private conversationSettingsStore: ModelAgentConversationSettingsStore;
  private workspaceContextService: ModelAgentWorkspaceContextService;
  private defaultsResolver: ModelAgentDefaultsResolver;
  private compactionState = new ModelAgentCompactionState();
  private promptContextAssembler: ModelAgentPromptContextAssembler;
  private agentProvider: string | null = null;
  private agentModel: string | null = null;
  private agentThinkingSettings: ThinkingSettings = { enabled: false, effort: 'medium' };
  private imageProvider: 'google' | 'openrouter' = 'google';
  private imageModel = 'gemini-2.5-flash-image';
  private transcriptionProvider: string | null = null;
  private transcriptionModel: string | null = null;
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
    this.setCurrentConversationId(conversationId ?? null);

    // Initialize services
    this.contextNotesManager = new ContextNotesManager();
    this.workspaceIntegration = new WorkspaceIntegrationService(app);
    this.conversationSettingsStore = new ModelAgentConversationSettingsStore(conversationService);
    this.workspaceContextService = new ModelAgentWorkspaceContextService(this.workspaceIntegration);
    this.defaultsResolver = new ModelAgentDefaultsResolver({
      app,
      staticModelsService: this.staticModelsService,
      workspaceContextService: this.workspaceContextService,
      getAvailableModels: () => this.getAvailableModels(),
      getAvailablePrompts: () => this.getAvailablePrompts(),
    });
    this.systemPromptBuilder = new SystemPromptBuilder(
      this.workspaceIntegration.readNoteContent.bind(this.workspaceIntegration),
      this.workspaceIntegration.loadWorkspace.bind(this.workspaceIntegration),
      this.workspaceIntegration.getBuiltInDocsWorkspaceInfo.bind(this.workspaceIntegration)
    );
    this.promptContextAssembler = new ModelAgentPromptContextAssembler({
      systemPromptBuilder: this.systemPromptBuilder,
      getSessionId: async () => await this.getCurrentSessionId(),
      getToolCatalog: () => {
        try {
          const plugin = getNexusPlugin(this.app) as { getServiceIfReady?<T>(name: string): T | null } | null;
          const agentManager = plugin?.getServiceIfReady?.<AgentManager>('agentManager');
          if (!agentManager) return [];
          return agentManager.getAgents()
            .filter((a: IAgent) => a.name !== 'toolManager')
            .map((a: IAgent) => ({
              agent: a.name,
              tools: a.getTools().map(t => t.slug),
            }));
        } catch {
          return [];
        }
      },
    });
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
   * Set the current conversation ID used for session lookups and persistence.
   */
  setCurrentConversationId(conversationId: string | null): void {
    this.currentConversationId = conversationId;
  }

  /**
   * Initialize from conversation metadata (if available), otherwise use plugin default
   */
  async initializeFromConversation(conversationId: string): Promise<void> {
    try {
      const { conversationMetadata, chatSettings } =
        await this.conversationSettingsStore.load(conversationId);

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

    // Restore image model
    if ('imageProvider' in settings && settings.imageProvider) {
      this.imageProvider = settings.imageProvider;
    }
    if ('imageModel' in settings && settings.imageModel) {
      this.imageModel = settings.imageModel;
    }

    // Restore transcription model
    if ('transcriptionProvider' in settings || 'transcriptionModel' in settings) {
      this.transcriptionProvider = settings.transcriptionProvider || null;
      this.transcriptionModel = settings.transcriptionModel || null;
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
    const workspaceState = await this.workspaceContextService.restoreWorkspace(workspaceId, sessionId);
    this.selectedWorkspaceId = workspaceState.selectedWorkspaceId;
    this.loadedWorkspaceData = workspaceState.loadedWorkspaceData;
    this.workspaceContext = workspaceState.workspaceContext;
  }

  /**
   * Initialize from plugin settings defaults (model, workspace, prompt, thinking)
   */
  private async initializeDefaultModel(): Promise<void> {
    try {
      const defaultState = await this.defaultsResolver.resolveDefaultState();

      this.selectedModel = defaultState.selectedModel;
      this.updateCompactionFrontierPolicy(defaultState.selectedModel);
      this.events.onModelChanged(defaultState.selectedModel);

      this.selectedPrompt = defaultState.selectedPrompt;
      this.currentSystemPrompt = defaultState.currentSystemPrompt;
      this.selectedWorkspaceId = defaultState.workspaceState.selectedWorkspaceId;
      this.workspaceContext = defaultState.workspaceState.workspaceContext;
      this.loadedWorkspaceData = defaultState.workspaceState.loadedWorkspaceData;
      this.contextNotesManager.clear();
      this.contextNotesManager.setNotes(defaultState.contextNotes);
      this.thinkingSettings = { ...defaultState.thinkingSettings };
      this.agentProvider = defaultState.agentProvider;
      this.agentModel = defaultState.agentModel;
      this.agentThinkingSettings = { ...defaultState.agentThinkingSettings };
      this.imageProvider = defaultState.imageProvider;
      this.imageModel = defaultState.imageModel;
      this.transcriptionProvider = defaultState.transcriptionProvider;
      this.transcriptionModel = defaultState.transcriptionModel;
      this.temperature = defaultState.temperature;

      this.events.onPromptChanged(defaultState.selectedPrompt);
      this.events.onSystemPromptChanged(defaultState.currentSystemPrompt);
    } catch {
      // Failed to initialize defaults
    }
  }

  /**
   * Save current selections to conversation metadata
   */
  async saveToConversation(conversationId: string): Promise<void> {
    try {
      await this.conversationSettingsStore.save(
        conversationId,
        this.buildChatSettingsMetadata()
      );
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
    return await this.defaultsResolver.getSelectedModelOrDefault(this.selectedModel);
  }

  /**
   * Resolve a provider/model pair to a ModelOption.
   * Falls back to static registry data, then to a minimal placeholder option
   * so per-conversation model settings are not silently lost when discovery is incomplete.
   */
  async resolveModelOption(providerId: string, modelId: string): Promise<ModelOption | null> {
    return await this.defaultsResolver.resolveModelOption(providerId, modelId);
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
    return await this.promptContextAssembler.buildSystemPrompt(this.getPromptContextSnapshot());
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
    this.compactionState.updateContextTokenTracker(provider);
  }

  /**
   * Handle prompt selection change
   */
  async handlePromptChange(prompt: PromptOption | null): Promise<void> {
    this.selectedPrompt = prompt;
    this.currentSystemPrompt = prompt?.systemPrompt || null;

    this.events.onPromptChanged(prompt);
    await this.refreshSystemPrompt();
  }

  /**
   * Set workspace context - loads full comprehensive data
   * When a workspace is selected in chat settings, load the same rich data
   * as the #workspace suggester (file structure, sessions, states, etc.)
   */
  async setWorkspaceContext(workspaceId: string): Promise<void> {
    const sessionId = await this.getCurrentSessionId();
    const workspaceState = await this.workspaceContextService.loadSelectedWorkspace(workspaceId, sessionId);
    this.selectedWorkspaceId = workspaceState.selectedWorkspaceId;
    this.loadedWorkspaceData = workspaceState.loadedWorkspaceData;
    this.workspaceContext = workspaceState.workspaceContext;

    await this.refreshSystemPrompt();
  }

  /**
   * Clear workspace context
   */
  async clearWorkspaceContext(): Promise<void> {
    const emptyWorkspaceState = this.workspaceContextService.createEmptyState();
    this.selectedWorkspaceId = emptyWorkspaceState.selectedWorkspaceId;
    this.workspaceContext = emptyWorkspaceState.workspaceContext;
    this.loadedWorkspaceData = emptyWorkspaceState.loadedWorkspaceData;
    await this.refreshSystemPrompt();
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
    await this.refreshSystemPrompt();
  }

  /**
   * Add context note
   */
  async addContextNote(notePath: string): Promise<void> {
    if (this.contextNotesManager.addNote(notePath)) {
      await this.refreshSystemPrompt();
    }
  }

  /**
   * Remove context note by index
   */
  async removeContextNote(index: number): Promise<void> {
    if (this.contextNotesManager.removeNote(index)) {
      await this.refreshSystemPrompt();
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
   * Get image provider
   */
  getImageProvider(): 'google' | 'openrouter' {
    return this.imageProvider;
  }

  /**
   * Get image model
   */
  getImageModel(): string {
    return this.imageModel;
  }

  /**
   * Set image model (provider and model)
   */
  setImageModel(provider: 'google' | 'openrouter', model: string): void {
    this.imageProvider = provider;
    this.imageModel = model;
  }

  /**
   * Get transcription provider
   */
  getTranscriptionProvider(): string | null {
    return this.transcriptionProvider;
  }

  /**
   * Get transcription model
   */
  getTranscriptionModel(): string | null {
    return this.transcriptionModel;
  }

  /**
   * Set transcription model (provider and model)
   */
  setTranscriptionModel(provider: string | null, model: string | null): void {
    this.transcriptionProvider = provider;
    this.transcriptionModel = model;
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
    this.compactionState.recordTokenUsage(promptTokens, completionTokens);
  }

  /**
   * Get current context status (for UI display or compaction checks)
   */
  getContextStatus(): ContextStatus | null {
    return this.compactionState.getContextStatus();
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
    return this.compactionState.shouldCompactBeforeSending(
      conversationOrMessage,
      message,
      systemPrompt,
      providerOverride || this.selectedModel?.providerId || null
    );
  }

  /**
   * Reset token tracker (after compaction or new conversation)
   */
  resetTokenTracker(): void {
    this.compactionState.resetTokenTracker();
  }

  /**
   * Check if using a token-limited local model
   */
  isUsingLocalModel(): boolean {
    return this.compactionState.isUsingLocalModel();
  }

  /**
   * Get the context token tracker (for direct access if needed)
   */
  getContextTokenTracker(): ContextTokenTracker | null {
    return this.compactionState.getContextTokenTracker();
  }

  // ========== Compaction Frontier ==========

  /**
   * Append a compaction record to the bounded frontier.
   */
  appendCompactionRecord(context: CompactedContext): void {
    this.compactionState.appendCompactionRecord(context);
  }

  private updateCompactionFrontierPolicy(model: ModelOption | null): void {
    this.compactionState.updatePolicy(model?.contextWindow);
  }

  getCompactionFrontierBudgetPolicy(): CompactionFrontierBudgetPolicy {
    return this.compactionState.getCompactionFrontierBudgetPolicy(this.selectedModel?.contextWindow);
  }

  /**
   * Append a record to metadata-backed frontier and return updated metadata.
   */
  buildMetadataWithCompactionRecord(
    metadata: Record<string, unknown> | undefined,
    compactionRecord: CompactedContext
  ): Record<string, unknown> {
    return this.compactionState.buildMetadataWithCompactionRecord(metadata, compactionRecord);
  }

  buildMetadataWithCompactionFrontier(
    metadata: Record<string, unknown> | undefined,
    frontier: CompactedContext[]
  ): Record<string, unknown> {
    return this.compactionState.buildMetadataWithCompactionFrontier(metadata, frontier);
  }

  /**
   * Get the latest active compaction record.
   */
  getLatestCompactionRecord(): CompactedContext | null {
    return this.compactionState.getLatestCompactionRecord();
  }

  /**
   * Get the current active compaction frontier.
   */
  getCompactionFrontier(): CompactionFrontierRecord[] {
    return this.compactionState.getCompactionFrontier();
  }

  /**
   * Clear compaction frontier (on new conversation or manual clear)
   */
  clearCompactionFrontier(): void {
    this.compactionState.clearCompactionFrontier();
  }

  /**
   * Check if there is compacted context in the frontier.
   */
  hasCompactionFrontier(): boolean {
    return this.compactionState.hasCompactionFrontier();
  }

  private restoreCompactionFrontierFromMetadata(
    metadata: ConversationMetadataWithCompaction | undefined
  ): void {
    this.compactionState.restoreCompactionFrontierFromMetadata(metadata);
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
    const modelSelectionUtility = ModelSelectionUtility as {
      getAvailableModels(app: App): Promise<ModelOption[]>;
    };
    return await modelSelectionUtility.getAvailableModels(this.app);
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
  async getMessageOptions(): Promise<ModelAgentMessageOptions> {
    return await this.promptContextAssembler.buildMessageOptions(this.getPromptContextSnapshot());
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
    if (!this.currentConversationId) {
      return undefined;
    }

    try {
      return await this.conversationSettingsStore.getSessionId(this.currentConversationId);
    } catch {
      return undefined;
    }
  }

  private buildChatSettingsMetadata(): ConversationSettingsMetadata {
    return {
      providerId: this.selectedModel?.providerId,
      modelId: this.selectedModel?.modelId,
      promptId: this.selectedPrompt?.id ?? null,
      workspaceId: this.selectedWorkspaceId,
      contextNotes: this.contextNotesManager.getNotes(),
      thinking: this.thinkingSettings,
      temperature: this.temperature,
      agentProvider: this.agentProvider,
      agentModel: this.agentModel,
      agentThinking: this.agentThinkingSettings,
      imageProvider: this.imageProvider,
      imageModel: this.imageModel,
      transcriptionProvider: this.transcriptionProvider,
      transcriptionModel: this.transcriptionModel
    };
  }

  private getPromptContextSnapshot(): ModelAgentPromptContextSnapshot {
    return {
      selectedModel: this.selectedModel,
      selectedWorkspaceId: this.selectedWorkspaceId,
      workspaceContext: this.workspaceContext,
      loadedWorkspaceData: this.loadedWorkspaceData,
      contextNotes: this.contextNotesManager.getNotes(),
      messageEnhancement: this.messageEnhancement,
      currentSystemPrompt: this.currentSystemPrompt,
      thinkingSettings: this.thinkingSettings,
      temperature: this.temperature,
      imageProvider: this.imageProvider,
      imageModel: this.imageModel,
      transcriptionProvider: this.transcriptionProvider,
      transcriptionModel: this.transcriptionModel,
      contextTokenTracker: this.compactionState.getContextTokenTracker(),
      compactionFrontier: this.compactionState.getCompactionFrontier(),
      latestCompactionRecord: this.compactionState.getLatestCompactionRecord()
    };
  }

  private async refreshSystemPrompt(): Promise<void> {
    this.events.onSystemPromptChanged(
      await this.promptContextAssembler.buildSystemPrompt(this.getPromptContextSnapshot())
    );
  }
}
