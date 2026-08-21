import { assertThinkingBehavior } from './thinkingAssertions';

describe('assertThinkingBehavior', () => {
  const expectation = {
    enabled: true,
    effort: 'medium' as const,
    minimumCharacters: 5,
    requireBeforeFirstTool: true,
    requireFinalText: true
  };

  it('passes when Nexus receives visible reasoning before a tool and a final answer', () => {
    expect(assertThinkingBehavior(expectation, {
      reasoningContent: 'considered constraints',
      reasoningEventCount: 2,
      reasoningBeforeFirstTool: true,
      sawToolCall: true,
      finalText: 'The answer is 42.'
    })).toEqual({ passed: true, errors: [] });
  });

  it('reports each missing Nexus-facing thinking behavior distinctly', () => {
    expect(assertThinkingBehavior(expectation, {
      reasoningContent: '',
      reasoningEventCount: 0,
      reasoningBeforeFirstTool: false,
      sawToolCall: true,
      finalText: ''
    })).toEqual({
      passed: false,
      errors: [
        'Thinking: expected at least 5 reasoning characters, received 0.',
        'Thinking: no reasoning event arrived before the first tool call.',
        'Thinking: tool continuation produced no final answer text.'
      ]
    });
  });
});
