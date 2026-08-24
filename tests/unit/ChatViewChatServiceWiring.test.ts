/**
 * Regression: ChatView must not capture `chatService` by value at construction.
 *
 * Obsidian's view factory (ChatUIManager.registerViewEarly) builds ChatView
 * during layout restoration — on every `plugin:reload` and on cold start — which
 * runs BEFORE the plugin's async service graph has produced `chatService`, so it
 * passes null. `waitForChatServiceAndInitialize()` assigns the real service to
 * the field a moment later.
 *
 * Any collaborator that copied `this.chatService` into a deps object inside the
 * constructor therefore held null forever. ChatSubagentIntegration did, and
 * dereferenced it unguarded:
 *
 *     TypeError: Cannot read properties of null (reading 'getLLMService')
 *
 * which meant SubagentController never initialized, PromptManagerAgent never
 * received a SubagentExecutor, and the `promptManager subagent` tool answered
 * "Subagent executor not initialized" for the whole life of that view.
 *
 * These tests exercise the REAL ChatView constructor and the REAL
 * ChatSubagentIntegration. The only doubles are the leaf-level services the
 * integration reaches for, and SubagentController (mocked so the test can read
 * the dependency bag it was handed). Nothing here re-implements the code under
 * test.
 */

// streaming-markdown is ESM-only and unresolvable from Jest's CJS runtime; it
// sits far down ChatView's import graph (MessageDisplay -> MessageBubble ->
// MarkdownRenderer) and none of its behaviour is under test here.
jest.mock(
  'streaming-markdown',
  () => ({
    default_renderer: () => ({}),
    parser: () => ({}),
    parser_write: () => undefined,
    parser_end: () => undefined,
  }),
  { virtual: true }
);

const subagentControllerInitializeCalls: unknown[][] = [];
const subagentControllerInstances: unknown[] = [];

jest.mock('../../src/ui/chat/controllers/SubagentController', () => ({
  SubagentController: jest.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = jest.fn((...args: unknown[]) => {
      subagentControllerInitializeCalls.push(args);
    });
    this.setNavigationCallbacks = jest.fn();
    this.cleanup = jest.fn();
    subagentControllerInstances.push(this);
    return this;
  }),
}));

import type { WorkspaceLeaf } from 'obsidian';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Harness {
  view: any;
  chatService: { getLLMService: jest.Mock; getConversationService: jest.Mock };
  warnings: string[];
}

async function buildHarness(): Promise<Harness> {
  const { ChatView } = await import('../../src/ui/chat/ChatView');

  const llmService = { id: 'llm-service' };
  const chatService = {
    getLLMService: jest.fn(() => llmService),
    getConversationService: jest.fn(() => ({ id: 'conversation-service' })),
  };

  const promptManagerAgent = { setSubagentExecutor: jest.fn() };
  const agentManager = {
    getAgent: jest.fn((name: string) => (name === 'promptManager' ? promptManagerAgent : null)),
    getAgents: jest.fn(() => []),
  };
  const plugin = {
    getService: jest.fn(async (name: string) => {
      if (name === 'directToolExecutor') return { executeToolCalls: jest.fn(), getAvailableTools: jest.fn() };
      if (name === 'agentManager') return agentManager;
      return null;
    }),
    getServiceIfReady: jest.fn((name: string) =>
      name === 'hybridStorageAdapter' ? { id: 'storage-adapter' } : null
    ),
  };

  const app = { plugins: { getPlugin: (id: string) => (id === 'nexus' ? plugin : null) } };
  const leaf = { app } as unknown as WorkspaceLeaf;

  // The reload window: Obsidian constructs the view before chatService exists.
  const view = new ChatView(leaf, null as never) as any;
  view.app = app;

  // Controllers that initializeArchitecture() would have built by the time
  // subagent init runs. Stubbed because they are not what this test is about.
  view.streamingController = { startStreaming: jest.fn(), updateStreamingChunk: jest.fn(), finalizeStreaming: jest.fn() };
  view.toolEventCoordinator = { handleToolCallsDetected: jest.fn() };

  const warnings: string[] = [];
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });

  return { view, chatService, warnings };
}

describe('ChatView chatService wiring across the reload window', () => {
  beforeEach(() => {
    subagentControllerInitializeCalls.length = 0;
    subagentControllerInstances.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes subagent infrastructure with the chatService assigned AFTER construction', async () => {
    const { view, chatService } = await buildHarness();

    // What waitForChatServiceAndInitialize() does once the service resolves.
    view.chatService = chatService;

    await view.initializeSubagentInfrastructure();

    expect(view.subagentController).not.toBeNull();
    expect(view.preservationService).not.toBeNull();

    expect(subagentControllerInitializeCalls).toHaveLength(1);
    const deps = subagentControllerInitializeCalls[0][0] as { chatService: unknown; llmService: unknown };
    // The live service, not the null the constructor was handed.
    expect(deps.chatService).toBe(chatService);
    expect(deps.llmService).toBe(chatService.getLLMService.mock.results[0].value);
  });

  it('degrades to a null result instead of throwing when chatService never arrives', async () => {
    const { view, warnings } = await buildHarness();

    // chatService stays null — the poll timed out.
    await expect(view.initializeSubagentInfrastructure()).resolves.toBeUndefined();

    expect(view.subagentController).toBeNull();
    expect(view.preservationService).toBeNull();
    expect(warnings.some(w => w.includes('chatService not available'))).toBe(true);
    expect(subagentControllerInitializeCalls).toHaveLength(0);
  });
});
