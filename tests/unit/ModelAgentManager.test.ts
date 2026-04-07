import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { ConversationData } from '../../src/types/chat/ChatTypes';
import { ModelSelectionUtility } from '../../src/ui/chat/utils/ModelSelectionUtility';
import type { WorkspaceContext } from '../../src/database/types/workspace/WorkspaceTypes';
import type { ModelOption, PromptOption } from '../../src/ui/chat/types/SelectionTypes';
import type { ModelAgentDefaultState } from '../../src/ui/chat/services/ModelAgentDefaultsResolver';

type SelectedModel = {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  contextWindow: number;
};

type ModelAgentManagerWithSelectedModel = ModelAgentManager & {
  selectedModel: SelectedModel;
  selectedPrompt: PromptOption | null;
  selectedWorkspaceId: string | null;
  workspaceContext: WorkspaceContext | null;
  loadedWorkspaceData: Record<string, unknown> | null;
  currentSystemPrompt: string | null;
  contextNotesManager: {
    setNotes(notes: string[]): void;
  };
  workspaceIntegration: {
    loadWorkspace: jest.Mock;
    bindSessionToWorkspace: jest.Mock;
  };
  workspaceContextService: {
    restoreWorkspace: jest.Mock;
    loadSelectedWorkspace: jest.Mock;
    createEmptyState: jest.Mock;
  };
  defaultsResolver: {
    resolveDefaultState: jest.Mock;
    getSelectedModelOrDefault: jest.Mock;
    resolveModelOption: jest.Mock;
  };
  promptContextAssembler: {
    buildSystemPrompt: jest.Mock;
    buildMessageOptions: jest.Mock;
  };
  systemPromptBuilder: {
    build: jest.Mock;
  };
};

describe('ModelAgentManager', () => {
  function createEvents() {
    return {
      onModelChanged: jest.fn(),
      onPromptChanged: jest.fn(),
      onSystemPromptChanged: jest.fn()
    };
  }

  function asManager(manager: ModelAgentManager): ModelAgentManagerWithSelectedModel {
    return manager as ModelAgentManagerWithSelectedModel;
  }

  function createModel(
    providerId: string,
    modelId: string,
    contextWindow = 200_000
  ): ModelOption {
    return {
      providerId,
      providerName: providerId,
      modelId,
      modelName: modelId,
      contextWindow
    };
  }

  function createPrompt(id: string, name: string): PromptOption {
    return {
      id,
      name,
      description: `${name} description`,
      systemPrompt: `${name} system prompt`
    };
  }

  function createConversation(content: string): ConversationData {
    return {
      id: 'conv_1',
      title: 'Test',
      created: Date.now(),
      updated: Date.now(),
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content,
          timestamp: Date.now(),
          conversationId: 'conv_1'
        }
      ]
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the shared compaction policy for supported non-webllm providers', () => {
    const manager = new ModelAgentManager(
      {},
      createEvents()
    );

    (manager as ModelAgentManagerWithSelectedModel).selectedModel = {
      providerId: 'github-copilot',
      modelId: 'copilot-model',
      providerName: 'GitHub Copilot',
      modelName: 'Copilot',
      contextWindow: 128000
    };

    const shouldCompact = manager.shouldCompactBeforeSending(
      createConversation('A'.repeat(725_000)),
      'follow-up'
    );

    expect(shouldCompact).toBe(true);
  });

  it('uses the configured current conversation id when resolving the session id', async () => {
    const conversationService = {
      getConversation: jest.fn().mockImplementation(async (conversationId: string) => ({
        metadata: {
          chatSettings: {
            sessionId: conversationId === 'conv_1' ? 'session_123' : 'unexpected'
          }
        }
      }))
    };
    const events = createEvents();

    const manager = new ModelAgentManager(
      {},
      events,
      conversationService
    );

    manager.setCurrentConversationId('conv_1');

    const options = await manager.getMessageOptions();

    expect(conversationService.getConversation).toHaveBeenCalledWith('conv_1');
    expect(options.sessionId).toBe('session_123');
  });

  it('restores model, prompt, workspace, notes, thinking, and agent settings from conversation metadata', async () => {
    const restoredModel = createModel('openai', 'gpt-5');
    const restoredPrompt = createPrompt('prompt_1', 'Review Prompt');
    const workspaceData = {
      id: 'workspace_1',
      context: {
        purpose: 'Ship the refactor',
      },
      files: ['docs/plan.md']
    };
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            providerId: restoredModel.providerId,
            modelId: restoredModel.modelId,
            promptId: restoredPrompt.id,
            workspaceId: 'workspace_1',
            sessionId: 'session_abc',
            contextNotes: ['Note A.md'],
            thinking: { enabled: true, effort: 'high' },
            temperature: 0.8,
            agentProvider: 'anthropic',
            agentModel: 'claude-sonnet',
            agentThinking: { enabled: true, effort: 'low' }
          }
        }
      })
    };
    const events = createEvents();
    const manager = new ModelAgentManager({}, events, conversationService);
    const access = asManager(manager);
    access.workspaceContextService = {
      restoreWorkspace: jest.fn().mockResolvedValue({
        selectedWorkspaceId: 'workspace_1',
        loadedWorkspaceData: workspaceData,
        workspaceContext: workspaceData.context
      }),
      loadSelectedWorkspace: jest.fn(),
      createEmptyState: jest.fn()
    } as unknown as ModelAgentManagerWithSelectedModel['workspaceContextService'];
    jest.spyOn(manager, 'getAvailableModels').mockResolvedValue([restoredModel]);
    jest.spyOn(manager, 'getAvailablePrompts').mockResolvedValue([restoredPrompt]);
    jest.spyOn(ModelSelectionUtility, 'findDefaultModelOption').mockResolvedValue(restoredModel);

    await manager.initializeFromConversation('conv_1');

    expect(manager.getSelectedModel()).toEqual(restoredModel);
    expect(manager.getSelectedPrompt()).toEqual(restoredPrompt);
    expect(manager.getSelectedWorkspaceId()).toBe('workspace_1');
    expect(manager.getLoadedWorkspaceData()).toEqual(workspaceData);
    expect(manager.getWorkspaceContext()).toEqual(workspaceData.context);
    expect(manager.getContextNotes()).toEqual(['Note A.md']);
    expect(manager.getThinkingSettings()).toEqual({ enabled: true, effort: 'high' });
    expect(manager.getTemperature()).toBe(0.8);
    expect(manager.getAgentProvider()).toBe('anthropic');
    expect(manager.getAgentModel()).toBe('claude-sonnet');
    expect(manager.getAgentThinkingSettings()).toEqual({ enabled: true, effort: 'low' });
    expect(access.workspaceContextService.restoreWorkspace).toHaveBeenCalledWith('workspace_1', 'session_abc');
  });

  it('preserves the existing session id when saving current selections to a conversation', async () => {
    const selectedModel = createModel('google', 'gemini-3.1-pro');
    const selectedPrompt = createPrompt('prompt_2', 'Research Prompt');
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            sessionId: 'session_existing'
          }
        }
      }),
      updateConversationMetadata: jest.fn().mockResolvedValue(undefined)
    };
    const manager = new ModelAgentManager({}, createEvents(), conversationService);
    const access = asManager(manager);
    access.selectedModel = selectedModel;
    access.selectedPrompt = selectedPrompt;
    access.selectedWorkspaceId = 'workspace_2';
    access.contextNotesManager.setNotes(['Spec.md']);
    manager.setThinkingSettings({ enabled: true, effort: 'medium' });
    manager.setTemperature(0.35);
    manager.setAgentModel('openai', 'gpt-5');
    manager.setAgentThinkingSettings({ enabled: false, effort: 'medium' });

    await manager.saveToConversation('conv_2');

    expect(conversationService.updateConversationMetadata).toHaveBeenCalledWith('conv_2', {
      chatSettings: {
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        promptId: selectedPrompt.id,
        workspaceId: 'workspace_2',
        contextNotes: ['Spec.md'],
        sessionId: 'session_existing',
        thinking: { enabled: true, effort: 'medium' },
        temperature: 0.35,
        agentProvider: 'openai',
        agentModel: 'gpt-5',
        agentThinking: { enabled: false, effort: 'medium' }
      }
    });
  });

  it('binds the current session and rebuilds the prompt when setting workspace context', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            sessionId: 'session_workspace'
          }
        }
      })
    };
    const events = createEvents();
    const manager = new ModelAgentManager({}, events, conversationService);
    const access = asManager(manager);
    const workspaceData = {
      id: 'workspace_3',
      context: {
        purpose: 'Audit the board',
      },
      files: ['Board.md']
    };
    access.workspaceContextService = {
      restoreWorkspace: jest.fn(),
      loadSelectedWorkspace: jest.fn().mockResolvedValue({
        selectedWorkspaceId: 'workspace_3',
        loadedWorkspaceData: workspaceData,
        workspaceContext: null
      }),
      createEmptyState: jest.fn()
    } as unknown as ModelAgentManagerWithSelectedModel['workspaceContextService'];
    access.promptContextAssembler = {
      buildSystemPrompt: jest.fn().mockResolvedValue('workspace prompt'),
      buildMessageOptions: jest.fn()
    } as unknown as ModelAgentManagerWithSelectedModel['promptContextAssembler'];
    manager.setCurrentConversationId('conv_3');

    await manager.setWorkspaceContext('workspace_3');

    expect(manager.getSelectedWorkspaceId()).toBe('workspace_3');
    expect(manager.getLoadedWorkspaceData()).toEqual(workspaceData);
    expect(access.workspaceContextService.loadSelectedWorkspace).toHaveBeenCalledWith('workspace_3', 'session_workspace');
    expect(access.promptContextAssembler.buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceId: 'workspace_3',
      loadedWorkspaceData: workspaceData
    }));
    expect(events.onSystemPromptChanged).toHaveBeenCalledWith('workspace prompt');
  });

  it('builds message options from the current model, prompt, workspace, session, and thinking state', async () => {
    const selectedModel = createModel('anthropic-claude-code', 'claude-sonnet-4-6');
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            sessionId: 'session_message_options'
          }
        }
      })
    };
    const manager = new ModelAgentManager({}, createEvents(), conversationService);
    const access = asManager(manager);
    access.selectedModel = selectedModel;
    access.currentSystemPrompt = 'Current selected prompt';
    access.selectedWorkspaceId = 'workspace_4';
    access.loadedWorkspaceData = { id: 'workspace_4', files: ['Task.md'] };
    access.contextNotesManager.setNotes(['Task.md']);
    access.promptContextAssembler = {
      buildSystemPrompt: jest.fn().mockResolvedValue('assembled system prompt'),
      buildMessageOptions: jest.fn().mockResolvedValue({
        provider: selectedModel.providerId,
        model: selectedModel.modelId,
        systemPrompt: 'assembled system prompt',
        workspaceId: 'workspace_4',
        sessionId: 'session_message_options',
        enableThinking: true,
        thinkingEffort: 'low',
        temperature: 0.6
      })
    } as unknown as ModelAgentManagerWithSelectedModel['promptContextAssembler'];
    manager.setThinkingSettings({ enabled: true, effort: 'low' });
    manager.setTemperature(0.6);
    manager.setCurrentConversationId('conv_4');

    const options = await manager.getMessageOptions();

    expect(options).toEqual({
      provider: selectedModel.providerId,
      model: selectedModel.modelId,
      systemPrompt: 'assembled system prompt',
      workspaceId: 'workspace_4',
      sessionId: 'session_message_options',
      enableThinking: true,
      thinkingEffort: 'low',
      temperature: 0.6
    });
    expect(access.promptContextAssembler.buildMessageOptions).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceId: 'workspace_4',
      contextNotes: ['Task.md'],
      currentSystemPrompt: 'Current selected prompt',
      loadedWorkspaceData: { id: 'workspace_4', files: ['Task.md'] }
    }));
  });

  it('applies resolved plugin defaults during initializeDefaults', async () => {
    const selectedModel = createModel('openai', 'gpt-5');
    const selectedPrompt = createPrompt('prompt_default', 'Default Prompt');
    const workspaceData = {
      id: 'workspace_default',
      context: { purpose: 'Default workspace' },
      files: ['Default.md']
    };
    const defaultState: ModelAgentDefaultState = {
      selectedModel,
      selectedPrompt,
      currentSystemPrompt: selectedPrompt.systemPrompt,
      workspaceState: {
        selectedWorkspaceId: 'workspace_default',
        workspaceContext: workspaceData.context,
        loadedWorkspaceData: workspaceData
      },
      contextNotes: ['Default.md'],
      thinkingSettings: { enabled: true, effort: 'high' },
      agentProvider: 'anthropic',
      agentModel: 'claude-sonnet',
      agentThinkingSettings: { enabled: true, effort: 'low' },
      temperature: 0.4
    };
    const events = createEvents();
    const manager = new ModelAgentManager({}, events);
    const access = asManager(manager);
    access.defaultsResolver = {
      resolveDefaultState: jest.fn().mockResolvedValue(defaultState),
      getSelectedModelOrDefault: jest.fn(),
      resolveModelOption: jest.fn()
    } as unknown as ModelAgentManagerWithSelectedModel['defaultsResolver'];

    await manager.initializeDefaults();

    expect(manager.getSelectedModel()).toEqual(selectedModel);
    expect(manager.getSelectedPrompt()).toEqual(selectedPrompt);
    expect(manager.getSelectedWorkspaceId()).toBe('workspace_default');
    expect(manager.getLoadedWorkspaceData()).toEqual(workspaceData);
    expect(manager.getContextNotes()).toEqual(['Default.md']);
    expect(manager.getThinkingSettings()).toEqual({ enabled: true, effort: 'high' });
    expect(manager.getAgentProvider()).toBe('anthropic');
    expect(manager.getAgentModel()).toBe('claude-sonnet');
    expect(manager.getAgentThinkingSettings()).toEqual({ enabled: true, effort: 'low' });
    expect(manager.getTemperature()).toBe(0.4);
    expect(events.onModelChanged).toHaveBeenCalledWith(selectedModel);
    expect(events.onPromptChanged).toHaveBeenCalledWith(selectedPrompt);
    expect(events.onSystemPromptChanged).toHaveBeenCalledWith(selectedPrompt.systemPrompt);
  });

  it('delegates model fallback resolution to the defaults resolver', async () => {
    const fallbackModel = createModel('google', 'gemini-fallback');
    const manager = new ModelAgentManager({}, createEvents());
    const access = asManager(manager);
    access.defaultsResolver = {
      resolveDefaultState: jest.fn(),
      getSelectedModelOrDefault: jest.fn(),
      resolveModelOption: jest.fn().mockResolvedValue(fallbackModel)
    } as unknown as ModelAgentManagerWithSelectedModel['defaultsResolver'];

    const resolved = await manager.resolveModelOption('google', 'gemini-fallback');

    expect(resolved).toEqual(fallbackModel);
    expect(access.defaultsResolver.resolveModelOption).toHaveBeenCalledWith('google', 'gemini-fallback');
  });
});
