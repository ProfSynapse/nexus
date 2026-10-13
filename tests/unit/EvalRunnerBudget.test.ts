/** A runaway tool loop must stop before another billed request, and caps must survive continuations. */
import { GoogleAdapter } from '../../src/services/llm/adapters/google/GoogleAdapter';
import type { GenerateOptions, StreamChunk } from '../../src/services/llm/adapters/types';
import { runScenario } from '../eval/EvalRunner';
import { SIMPLE_TOOLS } from '../eval/fixtures/tools';
import { loadConfig } from '../eval/ConfigLoader';
import type { EvalScenario } from '../eval/types';
import { generateReportJson } from '../eval/ReportGenerator';

const scenario: EvalScenario = {
  name: 'bounded-tool-loop', description: 'Budget regression', toolSet: 'simple',
  thinking: { enabled: true, effort: 'low', minimumCharacters: 1, requireBeforeFirstTool: true, requireFinalText: true },
  allowReorder: true,
  turns: [{ userMessage: 'What time is it?', expectedTools: [{ name: 'get_time' }],
    mockResponses: { get_time: { success: true, result: { time: '12:00' } } } }],
};

function toolChunk(id: number): StreamChunk {
  return { content: '', complete: true, toolCalls: [{ id: `call-${id}`, type: 'function',
    function: { name: 'get_time', arguments: '{}' } }] };
}

function config() {
  const value = loadConfig();
  return { ...value, mode: 'mock' as const,
    capture: { ...value.capture, enabled: false },
    defaults: { ...value.defaults, maxRetries: 0, maxTokens: 2048, maxToolIterations: 2 } };
}

const provider = { id: 'google', apiKey: 'not-a-real-key', models: ['gemini-4-argon'] };

afterEach(() => jest.restoreAllMocks());

test('forwards token caps through real tool continuations and captures canonical reasoning/text events', async () => {
  const requests: GenerateOptions[] = [];
  jest.spyOn(GoogleAdapter.prototype, 'generateStreamAsync').mockImplementation(async function* (_prompt, options) {
    requests.push(options!);
    if (requests.length < 3) {
      yield { content: '', reasoning: 'Check the clock.', complete: false };
      yield toolChunk(requests.length);
    } else {
      yield { content: 'It is noon.', complete: true };
    }
  });
  const result = await runScenario(scenario, provider, provider.models[0], SIMPLE_TOOLS, config(), []);
  expect(result.passed).toBe(true);
  expect(result.turns[0].textContent).toContain('It is noon.');
  expect(result.turns[0].reasoningBeforeFirstTool).toBe(true);
  expect(requests).toHaveLength(3);
  expect(requests.every(request => request.maxTokens === 2048)).toBe(true);
});

test('stops a runaway stream at the response boundary before another request or tool execution', async () => {
  let requests = 0;
  const stream = jest.spyOn(GoogleAdapter.prototype, 'generateStreamAsync').mockImplementation(async function* () {
    // Finite fallback keeps this regression test safe before the budget is implemented.
    if (++requests <= 5) yield toolChunk(requests);
    else yield { content: 'Unexpected extra request.', complete: true };
  });
  const result = await runScenario(scenario, provider, provider.models[0], SIMPLE_TOOLS, config(), []);
  expect(result.passed).toBe(false);
  expect(result.turns[0].errors.join(' ')).toContain('tool iteration budget');
  expect(stream).toHaveBeenCalledTimes(3);
  expect(result.turns[0].actualToolCalls).toHaveLength(2);
});

test('fails when the continuation errors after every expected tool has succeeded', async () => {
  let requests = 0;
  jest.spyOn(GoogleAdapter.prototype, 'generateStreamAsync').mockImplementation(async function* () {
    if (++requests === 1) yield toolChunk(1);
    else throw new Error('Provider continuation failed');
  });
  const result = await runScenario({ ...scenario, thinking: undefined }, provider,
    provider.models[0], SIMPLE_TOOLS, config(), []);
  expect(result.turns[0].actualToolCalls).toHaveLength(1);
  expect(result.passed).toBe(false);
  expect(result.turns[0].errors.join(' ')).toContain('Provider continuation failed');
});

test('records latest runtime usage once per response and retains incomplete continuation usage in JSON', async () => {
  let requests = 0;
  jest.spyOn(GoogleAdapter.prototype, 'generateStreamAsync').mockImplementation(async function* () {
    if (++requests === 1) {
      yield { content: '', complete: false, usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 } };
      yield { ...toolChunk(1), usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120,
        reasoningTokens: 10, cacheReadTokens: 40 } };
    } else {
      yield { content: '', complete: false, usage: { promptTokens: 150, completionTokens: 7, totalTokens: 157,
        reasoningTokens: 5 } };
      throw new Error('Stream interrupted');
    }
  });
  const runConfig = config();
  const result = await runScenario({ ...scenario, thinking: undefined }, provider,
    provider.models[0], SIMPLE_TOOLS, runConfig, []);
  expect(result.passed).toBe(false);
  const report = generateReportJson({ config: 'unit', mode: 'mock', schemaVersion: 'latest',
    results: [result], startTime: 0, endTime: 1 }, runConfig);
  expect(report.results[0].turns[0].responseUsage).toEqual([
    { completed: true, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120,
      reasoningTokens: 10, cacheReadTokens: 40 } },
    { completed: false, usage: { promptTokens: 150, completionTokens: 7, totalTokens: 157,
      reasoningTokens: 5 } },
  ]);
});
