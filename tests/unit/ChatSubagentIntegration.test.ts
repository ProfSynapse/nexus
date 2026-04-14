import type { App, Component } from 'obsidian';
jest.mock('../../src/ui/chat/controllers/SubagentController', () => ({
  SubagentController: jest.fn(),
}));

import { ChatSubagentIntegration } from '../../src/ui/chat/services/ChatSubagentIntegration';
import type { SubagentControllerEvents } from '../../src/ui/chat/controllers/SubagentController';

describe('ChatSubagentIntegration', () => {
  it('creates a shared context provider and initializes subagent dependencies', async () => {
    const currentConversation = { id: 'conv-1' };
    const conversationManager = {
      getCurrentConversation: jest.fn(() => currentConversation),
      selectConversation: jest.fn().mockResolvedValue(undefined),
    };
    const modelAgentManager = {
      getSelectedModel: jest.fn(() => ({ providerId: 'openai', modelId: 'gpt-5' })),
      getSelectedPrompt: jest.fn(() => ({ name: 'Prompt', systemPrompt: 'System prompt' })),
      getLoadedWorkspaceData: jest.fn(() => ({ workspace: 'data' })),
      getContextNotes: jest.fn(() => ['Note A']),
      getThinkingSettings: jest.fn(() => ({ enabled: true, effort: 'high' as const })),
      getSelectedWorkspaceId: jest.fn(() => 'workspace-1'),
    };
    const navigationTarget = {
      navigateToBranch: jest.fn().mockResolvedValue(undefined),
      continueSubagent: jest.fn().mockResolvedValue(undefined),
    };
    const streamingController = {} as never;
    const toolEventCoordinator = {} as never;
    const settingsButtonContainer = {} as HTMLElement;
    const settingsButton = {} as HTMLElement;
    const llmService = { name: 'llm-service' };
    const directToolExecutor = {
      executeToolCalls: jest.fn(),
    };
    const promptManagerAgent = { name: 'prompt-manager' };
    const storageAdapter = { name: 'storage-adapter' };
    const preservationService = { name: 'preservation-service' };

    const plugin = {
      getService: jest.fn(async (name: string) => {
        if (name === 'directToolExecutor') {
          return directToolExecutor;
        }
        if (name === 'agentManager') {
          return {
            getAgent: jest.fn((agentName: string) =>
              agentName === 'promptManager' ? promptManagerAgent : null
            ),
          };
        }
        return null;
      }),
      getServiceIfReady: jest.fn((name: string) =>
        name === 'hybridStorageAdapter' ? storageAdapter : null
      ),
    };

    let capturedEvents: SubagentControllerEvents | null = null;
    let capturedInitializeArgs: unknown[] | null = null;
    let capturedNavigationCallbacks:
      | {
          onNavigateToBranch: (branchId: string) => void;
          onContinueAgent: (branchId: string) => void;
        }
      | null = null;

    const subagentController = {
      initialize: jest.fn((...args: unknown[]) => {
        capturedInitializeArgs = args;
      }),
      setNavigationCallbacks: jest.fn((callbacks) => {
        capturedNavigationCallbacks = callbacks;
      }),
    };

    const createPreservationService = jest.fn(() => preservationService as never);

    const integration = new ChatSubagentIntegration({
      app: {} as App,
      component: {} as Component,
      chatService: {
        getLLMService: jest.fn(() => llmService),
      } as never,
      getConversationManager: () => conversationManager,
      getModelAgentManager: () => modelAgentManager,
      getStreamingController: () => streamingController,
      getToolEventCoordinator: () => toolEventCoordinator,
      getAgentStatusSlot: () => settingsButtonContainer,
      getSettingsButton: () => settingsButton,
      getNavigationTarget: () => navigationTarget,
      getPlugin: () => plugin,
      createSubagentController: (_app, _component, events) => {
        capturedEvents = events;
        return subagentController as never;
      },
      createPreservationService,
    });

    const contextProvider = integration.createContextProvider();
    expect(contextProvider.getCurrentConversation()).toBe(currentConversation);
    expect(contextProvider.getSelectedModel()).toEqual({ providerId: 'openai', modelId: 'gpt-5' });
    expect(contextProvider.getSelectedPrompt()).toEqual({ name: 'Prompt', systemPrompt: 'System prompt' });
    expect(contextProvider.getLoadedWorkspaceData()).toEqual({ workspace: 'data' });
    expect(contextProvider.getContextNotes()).toEqual(['Note A']);
    expect(contextProvider.getThinkingSettings()).toEqual({ enabled: true, effort: 'high' });
    expect(contextProvider.getSelectedWorkspaceId()).toBe('workspace-1');

    const result = await integration.initialize();

    expect(subagentController.initialize).toHaveBeenCalledTimes(1);
    expect(capturedInitializeArgs).not.toBeNull();
    const initializeArgs = capturedInitializeArgs as [
      {
        app: App;
        chatService: unknown;
        directToolExecutor: unknown;
        promptManagerAgent: unknown;
        storageAdapter: unknown;
        llmService: unknown;
      },
      typeof contextProvider,
      unknown,
      unknown,
      HTMLElement | undefined,
      HTMLElement | undefined,
    ];
    expect(initializeArgs[0]).toEqual(
      expect.objectContaining({
        directToolExecutor,
        promptManagerAgent,
        storageAdapter,
        llmService,
      })
    );
    expect(initializeArgs[1].getSelectedWorkspaceId()).toBe('workspace-1');
    expect(initializeArgs[2]).toBe(streamingController);
    expect(initializeArgs[3]).toBe(toolEventCoordinator);
    expect(initializeArgs[4]).toBe(settingsButtonContainer);
    expect(initializeArgs[5]).toBe(settingsButton);

    expect(capturedEvents).not.toBeNull();
    await capturedEvents?.onConversationNeedsRefresh?.('conv-1');
    expect(conversationManager.selectConversation).toHaveBeenCalledWith(currentConversation);

    expect(subagentController.setNavigationCallbacks).toHaveBeenCalledTimes(1);
    capturedNavigationCallbacks?.onNavigateToBranch('branch-1');
    capturedNavigationCallbacks?.onContinueAgent('branch-2');
    expect(navigationTarget.navigateToBranch).toHaveBeenCalledWith('branch-1');
    expect(navigationTarget.continueSubagent).toHaveBeenCalledWith('branch-2');

    expect(createPreservationService).toHaveBeenCalledTimes(1);
    expect(createPreservationService).toHaveBeenCalledWith(
      expect.objectContaining({
        llmService,
      })
    );
    expect(result).toEqual({
      preservationService,
      subagentController,
    });
  });

  it('returns null services when required plugin dependencies are unavailable', async () => {
    const integration = new ChatSubagentIntegration({
      app: {} as App,
      component: {} as Component,
      chatService: {
        getLLMService: jest.fn(() => ({ name: 'llm-service' })),
      } as never,
      getConversationManager: () => null,
      getModelAgentManager: () => null,
      getStreamingController: () => null,
      getToolEventCoordinator: () => null,
      getAgentStatusSlot: () => undefined,
      getSettingsButton: () => undefined,
      getNavigationTarget: () => null,
      getPlugin: () => null,
    });

    await expect(integration.initialize()).resolves.toEqual({
      preservationService: null,
      subagentController: null,
    });
  });
});
