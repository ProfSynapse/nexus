import { ContextPreservationService, type PreservationDependencies } from '../../src/services/chat/ContextPreservationService';
import type { ConversationMessage } from '../../src/types/chat/ChatTypes';
import { ContextBudgetService } from '../../src/services/chat/ContextBudgetService';

const checkpoint = { name: 'model name', conversationContext: 'Confirmed parser fix; publication remains pending.', activeTask: 'Verify the parser', activeFiles: ['src/parser.ts'], nextSteps: ['Run the real test'] };
const options = { provider: 'ollama', model: 'small', contextWindow: 4096, maxTokens: 409 };
const message = (content: string): ConversationMessage => ({ id: 'u1', role: 'user', content, timestamp: 1, conversationId: 'conv-state' });
function service(generateResponseStream: PreservationDependencies['llmService']['generateResponseStream']) {
  const executeToolCalls = jest.fn().mockResolvedValue([{ success: true, result: { success: true } }]);
  const preservation = new ContextPreservationService({
    llmService: { generateResponseStream },
    getAgent: () => ({ getTool: () => ({ getParameterSchema: () => ({ type: 'object' }) }) }) as never,
    executeToolCalls
  }, { maxRetries: 1 });
  return { preservation, executeToolCalls };
}

describe('conversation-derived compaction state', () => {
  it('reads original conversation, tool arguments and failed outcomes, then archives exactly the generated state once', async () => {
    const generate: jest.MockedFunction<PreservationDependencies['llmService']['generateResponseStream']> = jest.fn(async function* () { yield { chunk: JSON.stringify(checkpoint), complete: true }; });
    const { preservation, executeToolCalls } = service(generate);
    const messages: ConversationMessage[] = [message('Keep the original title, do not publish.'), {
      ...message(''), id: 'a1', role: 'assistant', toolCalls: [{ id: 't1', type: 'function', function: { name: 'contentManager_read', arguments: '{"path":"src/parser.ts"}' }, parameters: { resolvedPath: 'src/parser.ts' }, success: false, error: 'File not found' }]
    }, { ...message('Standalone evidence'), id: 't2', role: 'tool' }];
    const result = await preservation.createStateFromConversation(messages, { ...options, priorContext: 'Earlier user constraint: no release' }, { workspaceId: 'ws', sessionId: 'session' });
    expect(result.success).toBe(true);
    expect(generate.mock.calls[0][0][0].content).toEqual(expect.stringContaining('Keep the original title, do not publish.'));
    const input = generate.mock.calls[0][0][0].content;
    for (const evidence of ['src/parser.ts', 'Status: failed', 'Parameters: {"resolvedPath":"src/parser.ts"}', 'File not found', '[tool]: Standalone evidence', 'Earlier user constraint: no release']) expect(input).toContain(evidence);
    expect(generate.mock.calls[0][1]).toMatchObject({ tools: [], maxTokens: 409, enableThinking: false });
    expect(executeToolCalls).toHaveBeenCalledTimes(1);
    expect(executeToolCalls.mock.calls[0][1]).toEqual({ workspaceId: 'ws', sessionId: 'session' });
    expect(JSON.parse(executeToolCalls.mock.calls[0][0][0].function.arguments)).toEqual(result.savedState);
    expect(result.savedState).toMatchObject({ ...checkpoint, name: expect.stringMatching(/^Compaction /) });
  });

  it('rolls every segment of an oversized conversation through the selected small window before one final write', async () => {
    const generate: jest.MockedFunction<PreservationDependencies['llmService']['generateResponseStream']> = jest.fn(async function* () { yield { chunk: JSON.stringify(checkpoint), complete: true }; });
    const { preservation, executeToolCalls } = service(generate);
    const result = await preservation.createStateFromConversation([message(`FIRST ${'conversation '.repeat(4000)} LAST`)], options, {});
    expect(result.success).toBe(true);
    expect(generate.mock.calls.length).toBeGreaterThan(2);
    expect(generate.mock.calls[0][0][0].content).toContain('FIRST');
    expect(generate.mock.calls.at(-1)?.[0][0].content).toContain('LAST');
    for (const [messages, settings] of generate.mock.calls) {
      expect(ContextBudgetService.estimateTextTokens(messages[0].content + settings.systemPrompt) + options.maxTokens).toBeLessThan(options.contextWindow);
    }
    expect(generate.mock.calls[1][0][0].content).toContain(checkpoint.conversationContext);
    expect(executeToolCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { chunk: '{"conversationContext":"truncated"', complete: true },
    { chunk: JSON.stringify(checkpoint), complete: true, finishReason: 'length' },
    { chunk: JSON.stringify(checkpoint), complete: true, stopReason: 'max_tokens' },
    { chunk: JSON.stringify(checkpoint), complete: false },
    { chunk: '{}', complete: true },
  ])('never persists an invalid or incomplete draft: %j', async chunk => {
    const { preservation, executeToolCalls } = service(async function* () { yield chunk; });
    expect((await preservation.createStateFromConversation([message('original')], options, {})).success).toBe(false);
    expect(executeToolCalls).not.toHaveBeenCalled();
  });

  it.each([{ success: false, error: 'disk failed' }, { success: true, result: { success: false } }])('requires confirmed persistence: %j', async outcome => {
    const { preservation, executeToolCalls } = service(async function* () { yield { chunk: JSON.stringify(checkpoint), complete: true }; });
    executeToolCalls.mockResolvedValue([outcome]);
    expect((await preservation.createStateFromConversation([message('original')], options, {})).success).toBe(false);
    expect(executeToolCalls).toHaveBeenCalledTimes(1);
  });

  it('does not persist after cancellation', async () => {
    const controller = new AbortController();
    const { preservation, executeToolCalls } = service(async function* () { controller.abort(); yield { chunk: JSON.stringify(checkpoint), complete: true }; });
    expect((await preservation.createStateFromConversation([message('original')], { ...options, signal: controller.signal }, {})).success).toBe(false);
    expect(executeToolCalls).not.toHaveBeenCalled();
  });
});
