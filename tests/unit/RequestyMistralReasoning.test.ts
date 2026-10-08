import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false
}));

import { RequestyAdapter } from '../../src/services/llm/adapters/requesty/RequestyAdapter';
import { jsonResponse, sseResponse, sse, collect, concatContent, CapturedRequest } from './helpers/llmAdapterTestHarness';

const MODEL = 'mistral/mistral-large-4';

describe('Requesty Mistral Large 4 reasoning', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('requests high reasoning and separates the answer from typed thinking chunks', async () => {
    const requests: CapturedRequest[] = [];
    const assistantContent = [
      { type: 'thinking', thinking: [{ type: 'text', text: 'Work it out.' }] },
      { type: 'text', text: '42' }
    ];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, {
        choices: [{ message: { content: assistantContent }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
      });
    });

    const result = await new RequestyAdapter('test-key', MODEL).generateUncached('question', {
      enableThinking: true,
      thinkingEffort: 'max'
    });

    expect(JSON.parse(requests[0].body ?? '{}')).toMatchObject({ model: MODEL, reasoning_effort: 'high' });
    expect(result.text).toBe('42');
    expect(result.metadata).toMatchObject({ thinking: 'Work it out.', mistralAssistantContent: assistantContent });
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  });

  it('requests none when thinking is disabled and does not alter other models', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { choices: [{ message: { content: 'Direct answer' }, finish_reason: 'stop' }] });
    });

    await new RequestyAdapter('test-key', MODEL).generateUncached('question');
    await new RequestyAdapter('test-key', 'mistral/mistral-large-latest').generateUncached('question', { enableThinking: true });
    expect(JSON.parse(requests[0].body ?? '{}').reasoning_effort).toBe('none');
    expect(JSON.parse(requests[1].body ?? '{}')).not.toHaveProperty('reasoning_effort');
  });

  it('streams reasoning separately and retains the complete assistant content', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return sseResponse(sse(
        { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Step one.' }] }] } }] },
        { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: ' Step two.' }] }, { type: 'text', text: 'Answer' }] } }] },
        { choices: [{ delta: { content: ' complete' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } },
        '[DONE]'
      ));
    });

    const chunks = await collect(new RequestyAdapter('test-key', MODEL).generateStreamAsync('question', { enableThinking: true }));
    expect(JSON.parse(requests[0].body ?? '{}').reasoning_effort).toBe('high');
    expect(concatContent(chunks)).toBe('Answer complete');
    expect(chunks.filter(chunk => chunk.reasoning).map(chunk => chunk.reasoning).join('')).toBe('Step one. Step two.');
    expect(chunks.some(chunk => chunk.reasoningComplete)).toBe(true);
    expect(chunks[chunks.length - 1].metadata).toMatchObject({
      thinking: 'Step one. Step two.',
      mistralAssistantContent: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Step one.' }, { type: 'text', text: ' Step two.' }] },
        { type: 'text', text: 'Answer complete' }
      ]
    });
  });

  it('passes typed assistant history through to Requesty without stripping thinking', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return jsonResponse(200, { choices: [{ message: { content: 'Next answer' }, finish_reason: 'stop' }] });
    });
    const assistantContent = [
      { type: 'thinking', thinking: [{ type: 'text', text: 'Earlier reasoning' }] },
      { type: 'text', text: 'Earlier answer' }
    ];
    const history = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: 'Follow up' }
    ];

    await new RequestyAdapter('test-key', MODEL).generateUncached('Follow up', {
      enableThinking: true,
      conversationHistory: history
    });

    expect(JSON.parse(requests[0].body ?? '{}').messages).toEqual(history);
  });

  it('attaches typed assistant content to final tool calls for continuation', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Need a lookup.' }] }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"test"}' } }] } }] },
      { choices: [{ delta: { content: [{ type: 'text', text: 'Looking up now.' }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]'
    )));

    const chunks = await collect(new RequestyAdapter('test-key', MODEL).generateStreamAsync('question', { enableThinking: true }));
    const final = chunks[chunks.length - 1];
    expect(final.toolCallsReady).toBe(true);
    expect(final.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'lookup', arguments: '{"q":"test"}' },
      mistral_assistant_content: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Need a lookup.' }] },
        { type: 'text', text: 'Looking up now.' }
      ]
    });
  });

  it('keeps flat reasoning separate without fabricating typed assistant chunks', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { choices: [{ delta: { reasoning_content: 'Router reasoning.' } }] },
      { choices: [{ delta: { content: 'Answer', tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]'
    )));

    const chunks = await collect(new RequestyAdapter('test-key', MODEL).generateStreamAsync('question', { enableThinking: true }));
    const final = chunks[chunks.length - 1];
    expect(chunks.filter(chunk => chunk.reasoning).map(chunk => chunk.reasoning).join('')).toBe('Router reasoning.');
    expect(final.metadata).toMatchObject({ reasoningContent: 'Router reasoning.' });
    expect(final.metadata).not.toHaveProperty('mistralAssistantContent');
    expect(final.toolCalls?.[0]).not.toHaveProperty('mistral_assistant_content');
  });

  it('surfaces an in-stream provider error', async () => {
    __setRequestUrlMock(async () => sseResponse(sse(
      { choices: [{ delta: { content: 'Partial' } }] },
      { error: { message: 'reasoning effort rejected' } },
      '[DONE]'
    )));
    const adapter = new RequestyAdapter('test-key', MODEL);
    await expect(collect(adapter.generateStreamAsync('question', { enableThinking: true })))
      .rejects.toThrow('reasoning effort rejected');
  });

  it('advertises thinking only on the new model', async () => {
    const adapter = new RequestyAdapter('test-key', MODEL);
    const models = await adapter.listModels();
    expect(models.find(model => model.id === MODEL)?.supportsThinking).toBe(true);
    expect(models.find(model => model.id === 'mistral/mistral-large-latest')?.supportsThinking).toBe(false);
    expect(adapter.getCapabilities().supportsThinking).toBe(true);
    expect(new RequestyAdapter('test-key', 'mistral/mistral-large-latest').getCapabilities().supportsThinking).toBe(false);
  });
});
