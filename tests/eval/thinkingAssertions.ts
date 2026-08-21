import type { ThinkingExpectation } from './types';

export interface ThinkingObservation {
  reasoningContent: string;
  reasoningEventCount: number;
  reasoningBeforeFirstTool: boolean;
  sawToolCall: boolean;
  finalText: string;
}

export interface ThinkingAssertionResult {
  passed: boolean;
  errors: string[];
}

/** Grade only what the production stream exposed to Nexus. */
export function assertThinkingBehavior(
  expectation: ThinkingExpectation | undefined,
  observation: ThinkingObservation
): ThinkingAssertionResult {
  if (!expectation?.enabled) {
    return { passed: true, errors: [] };
  }

  const errors: string[] = [];
  const minimumCharacters = expectation.minimumCharacters ?? 1;
  const reasoningLength = observation.reasoningContent.trim().length;

  if (reasoningLength < minimumCharacters) {
    errors.push(
      `Thinking: expected at least ${minimumCharacters} reasoning characters, received ${reasoningLength}.`
    );
  }

  if (
    expectation.requireBeforeFirstTool &&
    observation.sawToolCall &&
    !observation.reasoningBeforeFirstTool
  ) {
    errors.push('Thinking: no reasoning event arrived before the first tool call.');
  }

  if (expectation.requireFinalText && !observation.finalText.trim()) {
    errors.push('Thinking: tool continuation produced no final answer text.');
  }

  return { passed: errors.length === 0, errors };
}
