/**
 * Subagent settings reach the request.
 *
 * Defect this buys: the subagent tool inherited the parent chat's provider,
 * model and thinking, never read the subagent settings, and SubagentExecutor
 * dropped thinking on the floor before the streaming generator. This test runs
 * the real chain — SubagentController context → SubagentTool → SubagentExecutor
 * → the controller's streaming generator — and asserts on what
 * `llmService.generateResponseStream` receives. Only storage, the tool
 * executor and the LLM call itself are stubbed. Sampling support comes from the
 * real registry: Claude Haiku 5.5 rejects temperature, Opus 4.6 accepts it.
 */
import { SubagentController, type SubagentContextProvider } from '../../src/ui/chat/controllers/SubagentController';
import { SubagentExecutor } from '../../src/services/chat/SubagentExecutor';
import { SubagentTool, type SubagentToolContext } from '../../src/agents/promptManager/tools/subagent';
import type { ConversationAgentSettings } from '../../src/services/llm/utils/SubagentModelResolver';
import type { LLMService } from '../../src/services/llm/core/LLMService';
import type { App, Component } from 'obsidian';

type StreamOptions = Record<string, unknown>;

function createLlmService(defaults: ReturnType<LLMService['getAgentDefaults']> = {}) {
  const calls: StreamOptions[] = [];
  const llmService = {
    generateResponseStream: jest.fn(async function* (_messages: unknown, options: StreamOptions) {
      calls.push(options);
      yield { type: 'assistant.delta', text: 'done' };
      yield { type: 'turn.completed' };
    }),
    getAgentDefaults: jest.fn(() => defaults),
    getAvailableProviders: jest.fn(() => ['openai', 'anthropic'])
  };
  return { llmService: llmService as unknown as LLMService, calls };
}

function createBranchService() {
  const messages: unknown[] = [];
  return {
    createSubagentBranch: jest.fn(async () => 'branch_1'),
    addMessageToBranch: jest.fn(async (_branchId: string, message: unknown) => { messages.push(message); }),
    getBranch: jest.fn(async () => ({ branch: { messages: [...messages] }, parentMessageId: 'msg_1' })),
    updateMessageInBranch: jest.fn(async () => undefined),
    updateBranchState: jest.fn(async () => undefined),
    messages
  };
}

function contextProvider(agent: ConversationAgentSettings | null): SubagentContextProvider {
  return {
    getCurrentConversation: () => ({ id: 'conv_1', title: 'T', created: 0, updated: 0, messages: [] }),
    getSelectedModel: () => ({ providerId: 'openai', modelId: 'gpt-5.4', contextWindow: 400_000 }),
    getSelectedPrompt: () => null,
    getLoadedWorkspaceData: () => null,
    getContextNotes: () => [],
    // The parent chat's own thinking must not leak into the subagent.
    getThinkingSettings: () => ({ enabled: false, effort: 'low' }),
    getSelectedWorkspaceId: () => null,
    getAgentSettings: () => agent
  };
}

async function runSubagent(agent: ConversationAgentSettings | null, llm = createLlmService()) {
  const controller = new SubagentController({} as App, {} as Component, {
    onStreamingUpdate: jest.fn(), onToolCallsDetected: jest.fn(), onStatusChanged: jest.fn()
  });
  const internals = controller as unknown as {
    buildSubagentContext(provider: SubagentContextProvider, llmService: LLMService): SubagentToolContext;
    createStreamingGenerator(llmService: LLMService, directToolExecutor: unknown): ConstructorParameters<typeof SubagentExecutor>[0]['streamingGenerator'];
  };
  const directToolExecutor = { getAvailableTools: jest.fn(async () => []), executeToolCalls: jest.fn(async () => []) };
  const branchService = createBranchService();
  const executor = new SubagentExecutor({
    branchService: branchService as never,
    messageQueueService: { enqueue: jest.fn(async () => undefined) } as never,
    directToolExecutor: directToolExecutor as never,
    streamingGenerator: internals.createStreamingGenerator(llm.llmService, directToolExecutor)
  });
  const finished = new Promise<void>((resolve, reject) => {
    executor.setEventHandlers({ onSubagentComplete: () => resolve(), onSubagentError: (_id, error) => reject(new Error(error)) });
  });

  const tool = new SubagentTool();
  tool.setSubagentExecutor(executor);
  tool.setContextProvider(() => internals.buildSubagentContext(contextProvider(agent), llm.llmService));
  const result = await tool.execute({ task: 'Summarise the notes' } as never);
  expect(result.success).toBe(true);
  await finished;

  expect(llm.calls).toHaveLength(1);
  return llm.calls[0];
}

describe('subagent settings reach the streaming request', () => {
  it('uses the subagent model and thinking, and sends no temperature to Haiku 5.5', async () => {
    const options = await runSubagent({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      thinking: { enabled: true, effort: 'high' },
      temperature: 0.3
    });

    expect(options).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      enableThinking: true,
      thinkingEffort: 'high'
    }));
    expect(options.temperature).toBeUndefined();
  });

  it('passes temperature to a model that accepts it (Opus 4.6)', async () => {
    const options = await runSubagent({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      thinking: { enabled: false, effort: 'medium' },
      temperature: 0.3
    });

    expect(options).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      enableThinking: false,
      temperature: 0.3
    }));
  });

  it('falls back to the default subagent model, then to the cloud chat model', async () => {
    const withDefault = await runSubagent(null, createLlmService({
      model: { provider: 'anthropic', model: 'claude-opus-4-6' },
      thinking: { enabled: true, effort: 'low' },
      agentTemperature: 0.2
    }));
    expect(withDefault).toEqual(expect.objectContaining({
      provider: 'anthropic', model: 'claude-opus-4-6', enableThinking: true, thinkingEffort: 'low', temperature: 0.2
    }));

    const inherited = await runSubagent(null);
    expect(inherited).toEqual(expect.objectContaining({ provider: 'openai', model: 'gpt-5.4', enableThinking: false }));
  });
});
