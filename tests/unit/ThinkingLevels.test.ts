/**
 * Thinking levels a provider/model distinguishes (owner decision 8: the
 * Thinking dropdown hides levels the model or provider does not support, and
 * shows all of them when there is no capability data).
 *
 * Defect this buys: a dropdown offering Extra high and Max for Gemini, which
 * the adapter silently sends as High. The expectations are cross-checked
 * against the adapters' own mapping functions, so a level list that drifted
 * from what is actually sent goes red.
 */
import {
  THINKING_EFFORTS,
  getSupportedThinkingEfforts,
  normalizeThinkingEffortForModel
} from '../../src/services/llm/utils/thinkingLevels';
import {
  clampThinkingEffortToHigh,
  mapAnthropicAdaptiveEffort,
  mapOpenAIThinkingEffort
} from '../../src/services/llm/utils/ThinkingEffortMapper';
import type { ThinkingEffort } from '../../src/types/llm/ProviderTypes';

describe('getSupportedThinkingEfforts', () => {
  it.each([
    ['anthropic', 'claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic', 'claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['anthropic', 'claude-opus-4-6:1m', ['low', 'medium', 'high', 'max']],
    ['anthropic-claude-code', 'claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['openai', 'gpt-5.4', ['low', 'medium', 'high', 'xhigh']],
    ['openai', 'gpt-5.6', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['openai', 'gpt-5', ['low', 'medium', 'high']],
    ['openai-codex', 'gpt-5.4', ['low', 'medium', 'high', 'xhigh']],
    ['google', 'gemini-3.1-pro-preview', ['low', 'medium', 'high']],
    ['google', 'gemini-3-pro-preview', ['low', 'high']],
    ['google-gemini-cli', 'gemini-3.5-flash', ['low', 'medium', 'high']],
    ['groq', 'openai/gpt-oss-120b', ['low', 'medium', 'high']],
    ['deepseek', 'deepseek-v4-pro-thinking', ['medium', 'max']],
    ['mistral', 'mistral-large-4', ['high']],
    ['requesty', 'mistral/mistral-large-4', ['high']],
    ['openrouter', 'mistralai/mistral-large-4-0:online', ['high']]
  ])('%s %s offers %j', (provider, model, expected) => {
    expect(getSupportedThinkingEfforts(provider, model)).toEqual(expected);
  });

  it('keeps every level for a manual-budget Claude model, whose budget lifts Extra high and Max', () => {
    expect(getSupportedThinkingEfforts('anthropic', 'claude-sonnet-4-5-20250929')).toEqual([...THINKING_EFFORTS]);
  });

  it('shows all five levels when there is no capability data', () => {
    expect(getSupportedThinkingEfforts('ollama', 'qwen3:8b')).toEqual([...THINKING_EFFORTS]);
    expect(getSupportedThinkingEfforts('openrouter', 'anthropic/claude-opus-5.5')).toEqual([...THINKING_EFFORTS]);
    expect(getSupportedThinkingEfforts('my-openai-compatible', 'local-model')).toEqual([...THINKING_EFFORTS]);
    expect(getSupportedThinkingEfforts(undefined, undefined)).toEqual([...THINKING_EFFORTS]);
  });

  it('agrees with the adapter mappings: every offered level is sent as itself', () => {
    const cases: Array<[string, string, (effort: ThinkingEffort) => string]> = [
      ['anthropic', 'claude-opus-4-6', effort => mapAnthropicAdaptiveEffort(effort, 'claude-opus-4-6')],
      ['anthropic-claude-code', 'claude-sonnet-4-6', effort => mapAnthropicAdaptiveEffort(effort, 'claude-sonnet-4-6')],
      ['openai', 'gpt-5.4', effort => mapOpenAIThinkingEffort(effort, 'gpt-5.4')],
      ['google', 'gemini-3.1-pro-preview', clampThinkingEffortToHigh]
    ];
    for (const [provider, model, send] of cases) {
      const offered = getSupportedThinkingEfforts(provider, model);
      for (const effort of offered) expect(send(effort)).toBe(effort);
      // Every hidden level behaves as one that is offered.
      for (const effort of THINKING_EFFORTS) {
        expect(offered).toContain(normalizeThinkingEffortForModel(provider, model, effort));
      }
    }
  });
});

describe('normalizeThinkingEffortForModel', () => {
  it('shows the level a stored effort really behaves as', () => {
    expect(normalizeThinkingEffortForModel('google', 'gemini-3.1-pro-preview', 'max')).toBe('high');
    expect(normalizeThinkingEffortForModel('openai', 'gpt-5.4', 'max')).toBe('xhigh');
    expect(normalizeThinkingEffortForModel('deepseek', 'deepseek-v4-pro-thinking', 'high')).toBe('max');
    expect(normalizeThinkingEffortForModel('deepseek', 'deepseek-v4-pro-thinking', 'low')).toBe('medium');
  });

  it('returns the stored effort unchanged when there is no capability data', () => {
    expect(normalizeThinkingEffortForModel('ollama', 'qwen3:8b', 'xhigh')).toBe('xhigh');
  });
});
