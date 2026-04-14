import type { App, Component } from 'obsidian';
import type NexusPlugin from '../../../main';
import type { AgentManager } from '../../../services/AgentManager';
import { ContextPreservationService } from '../../../services/chat/ContextPreservationService';
import type { PreservationDependencies } from '../../../services/chat/ContextPreservationService';
import type { ChatService } from '../../../services/chat/ChatService';
import type { DirectToolExecutor } from '../../../services/chat/DirectToolExecutor';
import type { HybridStorageAdapter } from '../../../database/adapters/HybridStorageAdapter';
import type { PromptManagerAgent } from '../../../agents/promptManager/promptManager';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { ToolEventCoordinator } from '../coordinators/ToolEventCoordinator';
import type { StreamingController } from '../controllers/StreamingController';
import {
  SubagentController,
  type SubagentContextProvider,
  type SubagentControllerEvents,
} from '../controllers/SubagentController';
import type { ConversationData } from '../../../types/chat/ChatTypes';

interface ConversationManagerLike {
  getCurrentConversation(): ConversationData | null;
  selectConversation(conversation: ConversationData): Promise<void>;
}

interface ModelAgentManagerLike {
  getSelectedModel(): { providerId?: string; modelId?: string } | null;
  getSelectedPrompt(): { name?: string; systemPrompt?: string } | null;
  getLoadedWorkspaceData(): Record<string, unknown> | null;
  getContextNotes(): string[];
  getThinkingSettings(): { enabled?: boolean; effort?: 'low' | 'medium' | 'high' } | null;
  getSelectedWorkspaceId(): string | null;
}

interface NavigationTarget {
  navigateToBranch(branchId: string): Promise<void>;
  continueSubagent(branchId: string): Promise<void>;
}

interface PluginServiceLocator {
  getService<T>(name: string): Promise<T | null>;
  getServiceIfReady<T>(name: string): T | null;
}

interface SubagentControllerLike {
  initialize(
    deps: {
      app: App;
      chatService: ChatService;
      directToolExecutor: DirectToolExecutor;
      promptManagerAgent: PromptManagerAgent;
      storageAdapter: HybridStorageAdapter;
      llmService: NonNullable<ReturnType<ChatService['getLLMService']>>;
    },
    contextProvider: SubagentContextProvider,
    streamingController: StreamingController,
    toolEventCoordinator: ToolEventCoordinator,
    settingsButtonContainer?: HTMLElement,
    settingsButton?: HTMLElement
  ): void;
  setNavigationCallbacks(callbacks: {
    onNavigateToBranch: (branchId: string) => void;
    onContinueAgent: (branchId: string) => void;
  }): void;
}

interface ChatSubagentIntegrationResult {
  preservationService: ContextPreservationService | null;
  subagentController: SubagentController | null;
}

interface ChatSubagentIntegrationDependencies {
  app: App;
  component: Component;
  chatService: ChatService;
  getConversationManager: () => ConversationManagerLike | null;
  getModelAgentManager: () => ModelAgentManagerLike | null;
  getStreamingController: () => StreamingController | null;
  getToolEventCoordinator: () => ToolEventCoordinator | null;
  getAgentStatusSlot: () => HTMLElement | undefined;
  getSettingsButton: () => HTMLElement | undefined;
  getNavigationTarget: () => NavigationTarget | null;
  getPlugin?: () => PluginServiceLocator | null;
  createSubagentController?: (
    app: App,
    component: Component,
    events: SubagentControllerEvents
  ) => SubagentControllerLike;
  createPreservationService?: (deps: PreservationDependencies) => ContextPreservationService;
}

export class ChatSubagentIntegration {
  constructor(private readonly deps: ChatSubagentIntegrationDependencies) {}

  createContextProvider(): SubagentContextProvider {
    return {
      getCurrentConversation: () => this.deps.getConversationManager()?.getCurrentConversation() ?? null,
      getSelectedModel: () => this.deps.getModelAgentManager()?.getSelectedModel() ?? null,
      getSelectedPrompt: () => this.deps.getModelAgentManager()?.getSelectedPrompt() ?? null,
      getLoadedWorkspaceData: () => this.deps.getModelAgentManager()?.getLoadedWorkspaceData() ?? null,
      getContextNotes: () => this.deps.getModelAgentManager()?.getContextNotes() || [],
      getThinkingSettings: () => this.deps.getModelAgentManager()?.getThinkingSettings() ?? null,
      getSelectedWorkspaceId: () => this.deps.getModelAgentManager()?.getSelectedWorkspaceId() ?? null,
    };
  }

  async initialize(): Promise<ChatSubagentIntegrationResult> {
    try {
      const plugin = this.getPlugin();
      if (!plugin) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: plugin not available');
        return { preservationService: null, subagentController: null };
      }

      const directToolExecutor = await plugin.getService<DirectToolExecutor>('directToolExecutor');
      if (!directToolExecutor) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: directToolExecutor not available');
        return { preservationService: null, subagentController: null };
      }

      const agentManager = await plugin.getService<AgentManager>('agentManager');
      if (!agentManager) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: agentManager not available');
        return { preservationService: null, subagentController: null };
      }

      const promptManagerAgent = agentManager.getAgent('promptManager') as PromptManagerAgent | null;
      if (!promptManagerAgent) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: promptManager agent not available');
        return { preservationService: null, subagentController: null };
      }

      const storageAdapter = plugin.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter');
      if (!storageAdapter) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: hybridStorageAdapter not available');
        return { preservationService: null, subagentController: null };
      }

      const llmService = this.deps.chatService.getLLMService();
      if (!llmService) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: llmService not available');
        return { preservationService: null, subagentController: null };
      }

      const streamingController = this.deps.getStreamingController();
      const toolEventCoordinator = this.deps.getToolEventCoordinator();
      if (!streamingController || !toolEventCoordinator) {
        console.warn('[ChatSubagentIntegration] Cannot initialize: streamingController or toolEventCoordinator not available');
        return { preservationService: null, subagentController: null };
      }

      const subagentController = this.createSubagentController();
      const contextProvider = this.createContextProvider();

      subagentController.initialize(
        {
          app: this.deps.app,
          chatService: this.deps.chatService,
          directToolExecutor,
          promptManagerAgent,
          storageAdapter,
          llmService,
        },
        contextProvider,
        streamingController,
        toolEventCoordinator,
        this.deps.getAgentStatusSlot(),
        this.deps.getSettingsButton()
      );

      subagentController.setNavigationCallbacks({
        onNavigateToBranch: (branchId) => {
          void this.deps.getNavigationTarget()?.navigateToBranch(branchId);
        },
        onContinueAgent: (branchId) => {
          void this.deps.getNavigationTarget()?.continueSubagent(branchId);
        },
      });

      const preservationService = this.createPreservationService(
        llmService,
        agentManager,
        directToolExecutor
      );

      return {
        preservationService,
        subagentController: subagentController as SubagentController,
      };
    } catch (error) {
      console.error('[ChatSubagentIntegration] Failed to initialize subagent infrastructure:', error);
      throw error;
    }
  }

  private getPlugin(): PluginServiceLocator | null {
    if (this.deps.getPlugin) {
      return this.deps.getPlugin();
    }

    return getNexusPlugin<NexusPlugin>(this.deps.app);
  }

  private createSubagentController(): SubagentControllerLike {
    const createSubagentController = this.deps.createSubagentController
      ?? ((app: App, component: Component, events: SubagentControllerEvents) =>
        new SubagentController(app, component, events));

    return createSubagentController(this.deps.app, this.deps.component, {
      onStreamingUpdate: () => { /* handled internally */ },
      onToolCallsDetected: () => { /* handled internally */ },
      onStatusChanged: () => { /* status menu auto-updates */ },
      onConversationNeedsRefresh: (conversationId: string) => {
        const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
        if (currentConversation?.id === conversationId) {
          void this.deps.getConversationManager()?.selectConversation(currentConversation);
        }
      },
    });
  }

  private createPreservationService(
    llmService: NonNullable<ReturnType<ChatService['getLLMService']>>,
    agentManager: AgentManager,
    directToolExecutor: DirectToolExecutor
  ): ContextPreservationService {
    const createPreservationService = this.deps.createPreservationService
      ?? ((deps: PreservationDependencies) => new ContextPreservationService(deps));

    return createPreservationService({
      llmService: llmService as unknown as PreservationDependencies['llmService'],
      getAgent: (name: string) => agentManager.getAgent(name),
      executeToolCalls: (toolCalls, context) =>
        directToolExecutor.executeToolCalls(toolCalls, context),
    });
  }
}
