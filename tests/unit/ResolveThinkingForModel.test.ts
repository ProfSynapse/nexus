/**
 * Thinking gate at the request boundary.
 *
 * Defect this buys: the stored thinking preference stays `enabled: true` while
 * the user is on a model that cannot reason, and before the gate it was sent
 * anyway. If `resolveThinkingForModel` stopped consulting the registry, the
 * Mistral Large case below would go red.
 */
import { resolveThinkingForModel } from '../../src/services/llm/utils/resolveThinkingForModel';
import { ModelRegistry } from '../../src/services/llm/adapters/ModelRegistry';

describe('resolveThinkingForModel', () => {
  it('turns thinking off for a registry model that cannot think, keeping the effort', () => {
    // Guard the fixture: the registry really says Mistral Large Latest cannot think.
    expect(ModelRegistry.findModel('mistral', 'mistral-large-latest')?.capabilities.supportsThinking).toBe(false);

    const stored = { enabled: true, effort: 'high' as const };
    const resolved = resolveThinkingForModel('mistral', 'mistral-large-latest', stored);

    expect(resolved).toEqual({ enabled: false, effort: 'high' });
    expect(stored).toEqual({ enabled: true, effort: 'high' });
  });

  it('passes thinking through for a model that can think', () => {
    expect(ModelRegistry.findModel('anthropic', 'claude-opus-5-5')?.capabilities.supportsThinking).toBe(true);
    expect(resolveThinkingForModel('anthropic', 'claude-opus-5-5', { enabled: true, effort: 'max' }))
      .toEqual({ enabled: true, effort: 'max' });
  });

  it('passes the preference through when the registry has no entry (no capability data)', () => {
    expect(resolveThinkingForModel('ollama', 'qwen3:8b', { enabled: true, effort: 'low' }))
      .toEqual({ enabled: true, effort: 'low' });
    expect(resolveThinkingForModel('openai', 'not-a-real-model', { enabled: true, effort: 'low' }))
      .toEqual({ enabled: true, effort: 'low' });
  });

  it('lets a caller-supplied capability override the registry', () => {
    expect(resolveThinkingForModel('ollama', 'llama3', { enabled: true, effort: 'low' }, { supportsThinking: false }))
      .toEqual({ enabled: false, effort: 'low' });
  });

  it('keeps thinking off when it was off, and defaults a missing effort to medium', () => {
    expect(resolveThinkingForModel('anthropic', 'claude-opus-5-5', { enabled: false, effort: 'low' }))
      .toEqual({ enabled: false, effort: 'low' });
    expect(resolveThinkingForModel('anthropic', 'claude-opus-5-5', null)).toEqual({ enabled: false, effort: 'medium' });
  });
});
