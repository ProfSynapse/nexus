import {
  ThinkingEffortMapper,
  mapAnthropicAdaptiveEffort,
  mapOpenAIThinkingEffort,
  clampThinkingEffortToHigh
} from '../../src/services/llm/utils/ThinkingEffortMapper';

describe('thinking effort provider boundaries', () => {
  it('keeps disabled thinking disabled at every mapper entry point', () => {
    const disabled = { enabled: false, effort: 'max' as const };
    expect(ThinkingEffortMapper.getAnthropicParams(disabled)).toBeNull();
    expect(ThinkingEffortMapper.getOpenAIParams(disabled, 'gpt-6-sol')).toBeNull();
    expect(ThinkingEffortMapper.getGoogleParams(disabled)).toBeNull();
    expect(ThinkingEffortMapper.getOpenRouterParams(disabled)).toBeNull();
    expect(ThinkingEffortMapper.getGroqParams(disabled)).toBeNull();
    expect(ThinkingEffortMapper.getDeepSeekParams(disabled)).toBeNull();
  });

  it.each(['low', 'medium', 'high'] as const)('preserves the existing %s tier', effort => {
    expect(mapOpenAIThinkingEffort(effort, 'gpt-6-sol')).toBe(effort);
    expect(mapAnthropicAdaptiveEffort(effort, 'claude-opus-5')).toBe(effort);
    expect(clampThinkingEffortToHigh(effort)).toBe(effort);
  });

  it('sends native max to GPT-6 and GPT-5.6 and clamps older OpenAI model families', () => {
    expect(mapOpenAIThinkingEffort('max', 'gpt-6.1-sol')).toBe('max');
    expect(mapOpenAIThinkingEffort('xhigh', 'gpt-6-astra')).toBe('xhigh');
    expect(mapOpenAIThinkingEffort('max', 'gpt-5.6-sol')).toBe('max');
    expect(mapOpenAIThinkingEffort('max', 'gpt-5.4')).toBe('xhigh');
    expect(mapOpenAIThinkingEffort('max', 'gpt-5.3-codex')).toBe('xhigh');
    expect(mapOpenAIThinkingEffort('max', 'gpt-5.2')).toBe('xhigh');
    expect(mapOpenAIThinkingEffort('max', 'gpt-5.1')).toBe('high');
    expect(ThinkingEffortMapper.getOpenAIParams({ enabled: true, effort: 'max' }, 'gpt-6-sol'))
      .toEqual({ reasoning: { effort: 'max' } });
  });

  it('uses Anthropic model-specific ceilings without raising xhigh to max', () => {
    expect(mapAnthropicAdaptiveEffort('max', 'claude-fable-5-1')).toBe('max');
    expect(mapAnthropicAdaptiveEffort('max', 'claude-haiku-5-5')).toBe('max');
    expect(mapAnthropicAdaptiveEffort('xhigh', 'claude-opus-4-8')).toBe('xhigh');
    expect(mapAnthropicAdaptiveEffort('xhigh', 'claude-opus-4-6')).toBe('high');
    expect(mapAnthropicAdaptiveEffort('xhigh', 'claude-sonnet-4-6')).toBe('high');
    expect(mapAnthropicAdaptiveEffort('xhigh', 'claude-mythos-5-preview')).toBe('high');
    expect(mapAnthropicAdaptiveEffort('max', 'claude-haiku-4-5-20251001')).toBe('high');
  });

  it('scales manual Anthropic Extra high and Max to the requested output cap', () => {
    expect(ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort: 'xhigh' }, 128000))
      .toEqual({ budget_tokens: 64000 });
    expect(ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort: 'max' }, 128000))
      .toEqual({ budget_tokens: 126976 });
    expect(ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort: 'max' }, 64000))
      .toEqual({ budget_tokens: 62976 });
    expect(ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort: 'max' }, 4096))
      .toEqual({ budget_tokens: 3072 });
    expect(ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort: 'high' }, 128000))
      .toEqual({ budget_tokens: 32000 });
  });

  it('clamps Gemini and Groq elevated levels to their provider ceiling', () => {
    expect(ThinkingEffortMapper.getGoogleParams({ enabled: true, effort: 'max' }))
      .toEqual(ThinkingEffortMapper.getGoogleParams({ enabled: true, effort: 'high' }));
    expect(ThinkingEffortMapper.getGroqParams({ enabled: true, effort: 'max' }))
      .toEqual({ reasoning_effort: 'high' });
    expect(ThinkingEffortMapper.getDeepSeekParams({ enabled: true, effort: 'max' }))
      .toEqual({ thinking: { type: 'enabled', reasoning_effort: 'max' } });
  });
});
