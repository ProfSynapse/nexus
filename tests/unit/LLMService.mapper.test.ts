/**
 * LLMService — Phase 2 mapper field-preservation tests (PR #142, M2)
 *
 * Covers the 5 fields the mapper in generateResponseStream now preserves:
 *   tool_call_id (incl. "" — post-M3 contract), tool_calls, reasoning_details,
 *   thought_signature, name.
 *
 * Stripping any of these has caused (or is a latent risk for) silent
 * degradations with Azure-via-OpenRouter (tool_call_id), Gemini-via-OpenRouter
 * (reasoning_details), Gemini direct (thought_signature), and legacy OpenAI
 * function-role messages (name).
 *
 * NOTE: This test will be deleted/rewritten in Phase 3 when the inline mapper
 * disappears (canonical-pipeline plan, Option B). Keep it minimal.
 */

// Mock StreamingOrchestrator BEFORE importing LLMService so LLMService picks
// up the mock and we can observe the mapped messages it passes through.
const captured: { messages: unknown; calls: number } = { messages: null, calls: 0 };
jest.mock('../../src/services/llm/core/StreamingOrchestrator', () => ({
  StreamingOrchestrator: jest.fn().mockImplementation(() => ({
    generateResponseStream: jest.fn(async function* (messages: unknown) {
      captured.messages = messages;
      captured.calls += 1;
      // empty async generator — we only care about input observation
    }),
  })),
}));

// AdapterRegistry constructs real adapters which touch globals we don't need.
jest.mock('../../src/services/llm/core/AdapterRegistry', () => ({
  AdapterRegistry: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    updateSettings: jest.fn(),
    clear: jest.fn(),
    waitForInit: jest.fn().mockResolvedValue(undefined),
    getAdapter: jest.fn(),
    setOnSettingsDirty: jest.fn(),
  })),
}));

jest.mock('../../src/services/llm/LLMSettingsNotifier', () => ({
  LLMSettingsNotifier: {
    onSettingsChanged: jest.fn().mockReturnValue({}),
    unsubscribe: jest.fn(),
  },
}));

import { LLMService } from '../../src/services/llm/core/LLMService';
import type { LLMProviderSettings } from '../../src/types';

function makeService(): LLMService {
  const settings: LLMProviderSettings = {
    providers: {},
    defaultModel: { provider: 'openai', model: 'gpt-test' },
  };
  return new LLMService(settings);
}

async function drive(svc: LLMService, messages: unknown[]): Promise<void> {
  // Iterate the async generator to ensure the mapper runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const _ of svc.generateResponseStream(messages as any)) {
    // consume — body intentionally empty
  }
}

describe('LLMService.generateResponseStream mapper — Phase 1+2 field preservation', () => {
  beforeEach(() => {
    captured.messages = null;
    captured.calls = 0;
  });

  it('preserves all 5 fields when present, including empty-string tool_call_id', async () => {
    const svc = makeService();
    const toolCalls = [{ id: 'call_abc', type: 'function', function: { name: 'f', arguments: '{}' } }];
    const reasoningDetails = [{ type: 'reasoning.summary', summary: 'thought' }];

    await drive(svc, [
      {
        role: 'assistant',
        content: 'hi',
        tool_calls: toolCalls,
        reasoning_details: reasoningDetails,
        thought_signature: 'sig_xyz',
        name: 'legacy_fn',
      },
      // tool_call_id === '' MUST survive (post-M3: downstream synthesis owns policy)
      { role: 'tool', content: '{}', tool_call_id: '' },
    ]);

    const out = captured.messages as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);

    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'hi',
      tool_calls: toolCalls,
      reasoning_details: reasoningDetails,
      thought_signature: 'sig_xyz',
      name: 'legacy_fn',
    });

    expect(out[1]).toHaveProperty('tool_call_id', '');
    expect(out[1]).toEqual({ role: 'tool', content: '{}', tool_call_id: '' });
  });

  it('does not emit spurious undefined fields when inputs are absent', async () => {
    const svc = makeService();
    await drive(svc, [{ role: 'user', content: 'hello' }]);

    const out = captured.messages as Array<Record<string, unknown>>;
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
    // Key-presence guard: no accidental `undefined` leakage.
    for (const key of ['tool_calls', 'tool_call_id', 'reasoning_details', 'thought_signature', 'name']) {
      expect(Object.prototype.hasOwnProperty.call(out[0], key)).toBe(false);
    }
  });

  it('ignores non-array tool_calls (Array.isArray guard, M5)', async () => {
    const svc = makeService();
    // truthy non-array — would pass a bare `if (m.tool_calls)` check
    await drive(svc, [{ role: 'assistant', content: 'x', tool_calls: 'not-an-array' }]);

    const out = captured.messages as Array<Record<string, unknown>>;
    expect(Object.prototype.hasOwnProperty.call(out[0], 'tool_calls')).toBe(false);
  });
});
