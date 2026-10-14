/**
 * executePrompt uses the subagent settings.
 *
 * Defect this buys: PromptExecutor sent no temperature and no thinking, and
 * picked the chat model whenever it was a cloud model, so the Subagents
 * settings ("Used for: subagents, saved prompts and automations") had no
 * effect on saved prompts. The full chain runs for real — tool batch executor
 * → ExecutePromptsTool → PromptExecutor → LLMService.executePrompt — with
 * only the LLM service stubbed. Sampling support comes from the registry:
 * Claude Haiku 5.5 rejects temperature, Opus 4.6 accepts it.
 */
import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import { ExecutePromptsTool } from '../../src/agents/promptManager/tools/executePrompts/executePrompts';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { LLMService } from '../../src/services/llm/core/LLMService';
import type { AgentDefaults, ConversationAgentSettings } from '../../src/services/llm/utils/SubagentModelResolver';

function createLlmService(defaults: AgentDefaults) {
  const executePrompt = jest.fn(async (options: { provider?: string; model?: string }) => ({
    success: true,
    response: 'ok',
    provider: options.provider,
    model: options.model
  }));
  const llmService = {
    executePrompt,
    getAvailableProviders: jest.fn(() => ['openai', 'anthropic']),
    getAvailableModels: jest.fn(async () => [
      { provider: 'openai', id: 'gpt-5.4' },
      { provider: 'anthropic', id: 'claude-haiku-5-5' },
      { provider: 'anthropic', id: 'claude-opus-4-6' }
    ]),
    getAgentDefaults: jest.fn(() => defaults),
    getAgentModel: jest.fn(() => defaults.model),
    getDefaultModel: jest.fn(() => ({ provider: 'openai', model: 'gpt-5.4' }))
  };
  return { llmService: llmService as unknown as LLMService, executePrompt };
}

function createService(tool: ExecutePromptsTool): ToolBatchExecutionService {
  const agent: IAgent = {
    name: 'promptManager',
    description: '',
    version: '1.0.0',
    getTools: () => [tool],
    getTool: (slug: string) => (slug === tool.slug ? tool : undefined),
    initialize: jest.fn().mockResolvedValue(undefined),
    executeTool: jest.fn(),
    setAgentManager: jest.fn()
  };
  return new ToolBatchExecutionService({} as never, new Map([['promptManager', agent]]));
}

const DEFAULTS: AgentDefaults = {
  model: { provider: 'anthropic', model: 'claude-opus-4-6' },
  thinking: { enabled: true, effort: 'high' },
  agentTemperature: 0.3,
  defaultTemperature: 0.9
};

const CHAT_AGENT: ConversationAgentSettings = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  thinking: { enabled: true, effort: 'low' },
  temperature: 0.6
};

async function runPrompt(options: {
  prompt?: Record<string, unknown>;
  origin?: { operationOrigin?: 'native-chat'; conversationId?: string };
  viewConversationId?: string;
}) {
  const { llmService, executePrompt } = createLlmService(DEFAULTS);
  const tool = new ExecutePromptsTool(undefined, llmService, {} as never, undefined, {} as never);
  tool.setAgentContextProvider(() => ({ conversationId: options.viewConversationId ?? 'conv_1', conversationAgent: CHAT_AGENT }));
  const result = await createService(tool).execute({
    context: { workspaceId: 'default', sessionId: 's', memory: 'm', goal: 'g' },
    calls: [{ agent: 'promptManager', tool: 'execute', params: { prompts: [{ type: 'text', prompt: 'Hi', ...options.prompt }] } }]
  }, options.origin);
  expect(result.success).toBe(true);
  expect(executePrompt).toHaveBeenCalledTimes(1);
  return executePrompt.mock.calls[0][0] as Record<string, unknown>;
}

describe('executePrompt agent settings', () => {
  it('uses the default subagent model, Creativity and thinking (not the cloud chat model)', async () => {
    const sent = await runPrompt({});

    expect(sent).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      temperature: 0.3,
      enableThinking: true,
      thinkingEffort: 'high'
    }));
  });

  it("uses this chat's subagent settings when internal chat calls it, without a temperature for Haiku 5.5", async () => {
    const sent = await runPrompt({ origin: { operationOrigin: 'native-chat', conversationId: 'conv_1' } });

    expect(sent).toEqual(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      enableThinking: true,
      thinkingEffort: 'low'
    }));
    expect(sent.temperature).toBeUndefined();
  });

  it("ignores the chat view's settings for another conversation", async () => {
    const sent = await runPrompt({ origin: { operationOrigin: 'native-chat', conversationId: 'conv_2' } });
    expect(sent).toEqual(expect.objectContaining({ model: 'claude-opus-4-6' }));
  });

  it('lets an explicit tool parameter choose the model', async () => {
    const sent = await runPrompt({ prompt: { provider: 'openai', model: 'gpt-5.4' } });
    expect(sent).toEqual(expect.objectContaining({ provider: 'openai', model: 'gpt-5.4' }));
  });
});
