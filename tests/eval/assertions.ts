/**
 * tests/eval/assertions.ts — Tool call matchers and text content assertions.
 *
 * Provides flexible assertion helpers for eval scenarios. Tool name matching
 * is exact; parameter matching uses partial (objectContaining) semantics.
 * Used by EvalRunner to evaluate turn results.
 */

import type { ExpectedToolCall, CapturedToolCall } from './types';

export interface AssertionResult {
  passed: boolean;
  errors: string[];
}

/**
 * Assert that captured tool calls match expected tool calls.
 *
 * Rules:
 * - All non-optional expected tools must appear (by name) in actual calls
 * - Order is not enforced (LLMs may reorder)
 * - If params are specified on an expected tool, actual args must contain them (partial match)
 * - Extra tool calls (not in expected list) are noted but not failures
 */
export function assertToolCalls(
  expected: ExpectedToolCall[],
  actual: CapturedToolCall[]
): AssertionResult {
  const errors: string[] = [];
  const actualNames = actual.map((c) => c.name);

  for (const exp of expected) {
    if (exp.optional) continue;

    const matchIndex = actual.findIndex((a) => a.name === exp.name);
    if (matchIndex === -1) {
      errors.push(`Expected tool "${exp.name}" was not called. Actual calls: [${actualNames.join(', ')}]`);
      continue;
    }

    // Check params if specified
    if (exp.params) {
      const actualArgs = actual[matchIndex].args;
      checkToolParams(exp.name, exp.params, actualArgs, errors);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Assert that captured tool calls match expected tool call ROUNDS in order.
 *
 * In production, a single generateResponseStream() call can produce multiple
 * rounds of tool calls via ToolContinuationService's internal pingpong.
 * This asserts that the captured calls match the expected rounds sequentially:
 *   round 0's expected tools → first N captured calls
 *   round 1's expected tools → next M captured calls
 *   etc.
 *
 * Within each round, order is not enforced (model may reorder parallel calls).
 */
export function assertToolCallRounds(
  roundExpectations: ExpectedToolCall[][],
  actualCalls: CapturedToolCall[]
): AssertionResult {
  const errors: string[] = [];
  let callOffset = 0;

  for (let roundIdx = 0; roundIdx < roundExpectations.length; roundIdx++) {
    const expected = roundExpectations[roundIdx];
    const requiredCount = expected.filter(e => !e.optional).length;

    // Determine how many actual calls belong to this round.
    // We consume `requiredCount` calls from the actual list for this round.
    // If the model made more calls than expected (parallel calls), we allow extras.
    const roundCalls = actualCalls.slice(callOffset, callOffset + Math.max(requiredCount, 1));

    if (roundCalls.length === 0 && requiredCount > 0) {
      errors.push(
        `Round ${roundIdx}: Expected ${requiredCount} tool call(s) [${expected.map(e => e.name).join(', ')}] but no more calls were captured. Total captured: ${actualCalls.length}, consumed so far: ${callOffset}`
      );
      continue;
    }

    // Check each expected tool appears in this round's calls
    for (const exp of expected) {
      if (exp.optional) continue;

      const matchIndex = roundCalls.findIndex(a => a.name === exp.name);
      if (matchIndex === -1) {
        errors.push(
          `Round ${roundIdx}: Expected tool "${exp.name}" not found. Round calls: [${roundCalls.map(c => c.name).join(', ')}]`
        );
        continue;
      }

      // Check params if specified
      if (exp.params) {
        const actualArgs = roundCalls[matchIndex].args;
        checkToolParams(exp.name, exp.params, actualArgs, errors, `Round ${roundIdx}, `);
      }
    }

    callOffset += Math.max(roundCalls.length, requiredCount);
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Assert that the response text contains expected keywords/phrases.
 */
export function assertTextContains(
  text: string,
  expectedPhrases: string[]
): AssertionResult {
  const errors: string[] = [];
  const lowerText = text.toLowerCase();

  for (const phrase of expectedPhrases) {
    if (!lowerText.includes(phrase.toLowerCase())) {
      errors.push(`Response text missing expected phrase: "${phrase}"`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Assert that no hallucinated tool names appear in the actual calls.
 * Hallucinated = tool name not in the set of defined tool names.
 */
export function assertNoHallucinatedTools(
  actual: CapturedToolCall[],
  validToolNames: string[]
): AssertionResult {
  const errors: string[] = [];
  const validSet = new Set(validToolNames);

  for (const call of actual) {
    if (!validSet.has(call.name)) {
      errors.push(`Hallucinated tool call: "${call.name}" is not in the defined tool set`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Check tool params with special handling for getTools agent format normalization.
 * For getTools calls, `request` and `agents` are treated as equivalent — both
 * are normalized to a sorted agent name list before comparison.
 */
function checkToolParams(
  toolName: string,
  expectedParams: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
  errors: string[],
  prefix = '',
): void {
  // Special case: getTools agent format normalization
  if (toolName === 'getTools' && ('request' in expectedParams || 'agents' in expectedParams)) {
    const expectedAgents = normalizeGetToolsAgents(expectedParams as Record<string, unknown>);
    const actualAgents = normalizeGetToolsAgents(actualArgs);

    if (expectedAgents && actualAgents) {
      // Compare agent name sets — order doesn't matter, check containment
      const missing = expectedAgents.filter(a => !actualAgents.includes(a));
      if (missing.length > 0) {
        errors.push(
          `${prefix}tool "${toolName}": expected agents [${expectedAgents.join(', ')}] but got [${actualAgents.join(', ')}], missing: [${missing.join(', ')}]`
        );
      }
      return;
    }
  }

  // Standard param checking
  for (const [key, expectedValue] of Object.entries(expectedParams)) {
    if (!(key in actualArgs)) {
      errors.push(
        `${prefix}tool "${toolName}": expected param "${key}" not found in args ${JSON.stringify(actualArgs)}`
      );
    } else if (!deepPartialMatch(actualArgs[key], expectedValue)) {
      errors.push(
        `${prefix}tool "${toolName}": param "${key}" expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualArgs[key])}`
      );
    }
  }
}

/**
 * Normalize getTools params so both `agents` (string[]) and `request` (object[])
 * formats are comparable. The real getTools schema accepts `request: [{agent, tools?}]`,
 * but models often use the simpler `agents: ["X", "Y"]` shorthand.
 *
 * This extracts the agent names from either format into a sorted string[] so
 * assertion matching works regardless of which format the model chose.
 */
function normalizeGetToolsAgents(args: Record<string, unknown>): string[] | null {
  if (args.request && Array.isArray(args.request)) {
    return (args.request as Array<{ agent: string }>)
      .map(r => r.agent)
      .filter(Boolean)
      .sort();
  }
  if (args.agents && Array.isArray(args.agents)) {
    return (args.agents as string[]).filter(Boolean).sort();
  }
  return null;
}

/**
 * Deep partial match: check if `actual` contains all fields from `expected`.
 * For objects, recurses into nested fields. For primitives, uses strict equality.
 */
function deepPartialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) {
    return true;
  }

  if (typeof expected !== 'object' || expected === null) {
    // Primitive comparison — use loose string matching for flexibility
    if (typeof expected === 'string' && typeof actual === 'string') {
      return actual.toLowerCase().includes(expected.toLowerCase());
    }
    return actual === expected;
  }

  if (typeof actual !== 'object' || actual === null) {
    return false;
  }

  // Object partial match
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (!deepPartialMatch((actual as Record<string, unknown>)[key], value)) {
      return false;
    }
  }

  return true;
}
