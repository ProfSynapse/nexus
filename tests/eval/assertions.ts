/**
 * tests/eval/assertions.ts — Tool call matchers and text content assertions.
 *
 * Provides CLI-first assertion helpers for eval scenarios. Meta-tool checks
 * verify top-level `tool` selector/command strings rather than the old
 * structured `request` / `calls` payloads.
 */

import type { ExpectedToolCall, CapturedToolCall } from './types';

export interface AssertionResult {
  passed: boolean;
  errors: string[];
}

type NormalizedSelector = {
  agent: string;
  tool?: string;
};

function splitTopLevelSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if ((char === '"' || char === '\'') && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      current += char;
      continue;
    }

    if (char === ',' && !quote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }

  return segments;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

function parseSelectors(value: string): NormalizedSelector[] {
  return splitTopLevelSegments(value)
    .map((segment) => tokenize(segment))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => ({
      agent: toKebabCase(tokens[0]),
      ...(tokens[1] ? { tool: toKebabCase(tokens[1].replace(/^--/, '')) } : {}),
    }));
}

function parseCommands(value: string): NormalizedSelector[] {
  return splitTopLevelSegments(value)
    .map((segment) => tokenize(segment))
    .filter((tokens) => tokens.length >= 2)
    .map((tokens) => ({
      agent: toKebabCase(tokens[0]),
      tool: toKebabCase(tokens[1].replace(/^--/, '')),
    }));
}

function formatSelector(selector: NormalizedSelector): string {
  return selector.tool ? `${selector.agent}.${selector.tool}` : selector.agent;
}

function prefixForRound(roundIdx: number): string {
  return `Round ${roundIdx}, `;
}

function assertCliMetaArgs(
  toolName: string,
  actualArgs: Record<string, unknown>,
  errors: string[],
  prefix = '',
): void {
  if (toolName !== 'getTools' && toolName !== 'useTools') {
    return;
  }

  const value = actualArgs.tool;
  if (typeof value !== 'string' || value.trim().length === 0) {
    const label = toolName === 'getTools' ? 'CLI selector string' : 'CLI command string';
    errors.push(`${prefix}tool "${toolName}": expected top-level ${label} in args.tool, got ${JSON.stringify(actualArgs)}`);
  }
}

function paramsMatch(
  toolName: string,
  expectedParams: Record<string, unknown> | undefined,
  actualArgs: Record<string, unknown>,
): boolean {
  if (!expectedParams) {
    return true;
  }

  if (toolName === 'getTools' && typeof expectedParams.tool === 'string') {
    const expectedSelectors = parseSelectors(expectedParams.tool);
    const actualSelectors = typeof actualArgs.tool === 'string' ? parseSelectors(actualArgs.tool) : [];
    return expectedSelectors.every((expected) => actualSelectors.some((actual) => {
      if (actual.agent !== expected.agent) return false;
      if (!expected.tool) return true;
      return actual.tool === expected.tool;
    }));
  }

  if (toolName === 'useTools' && typeof expectedParams.tool === 'string') {
    const expectedCommands = parseCommands(expectedParams.tool);
    const actualCommands = typeof actualArgs.tool === 'string' ? parseCommands(actualArgs.tool) : [];
    return expectedCommands.every((expected) => actualCommands.some((actual) =>
      actual.agent === expected.agent && actual.tool === expected.tool,
    ));
  }

  return Object.entries(expectedParams).every(([key, value]) => deepPartialMatch(actualArgs[key], value));
}

/**
 * Assert that captured tool calls match expected tool calls.
 */
export function assertToolCalls(
  expected: ExpectedToolCall[],
  actual: CapturedToolCall[],
): AssertionResult {
  const errors: string[] = [];
  const actualNames = actual.map((c) => c.name);

  for (const exp of expected) {
    if (exp.optional) continue;

    let matchIndex = actual.findIndex((entry) => entry.name === exp.name && paramsMatch(exp.name, exp.params, entry.args));
    if (matchIndex === -1) {
      matchIndex = actual.findIndex((entry) => entry.name === exp.name);
    }
    if (matchIndex === -1) {
      errors.push(`Expected tool "${exp.name}" was not called. Actual calls: [${actualNames.join(', ')}]`);
      continue;
    }

    const actualArgs = actual[matchIndex].args;
    assertCliMetaArgs(exp.name, actualArgs, errors);

    if (exp.params) {
      checkToolParams(exp.name, exp.params, actualArgs, errors);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Assert that captured tool calls match expected tool call rounds in order.
 */
export function assertToolCallRounds(
  roundExpectations: ExpectedToolCall[][],
  actualCalls: CapturedToolCall[],
): AssertionResult {
  const errors: string[] = [];
  let callOffset = 0;

  for (let roundIdx = 0; roundIdx < roundExpectations.length; roundIdx++) {
    const expected = roundExpectations[roundIdx];
    const required = expected.filter((entry) => !entry.optional);
    const requiredCount = required.length;

    let endIndex = callOffset;
    const matched = new Set<number>();
    for (; endIndex < actualCalls.length; endIndex++) {
      const call = actualCalls[endIndex];
      for (let expectedIdx = 0; expectedIdx < required.length; expectedIdx++) {
        if (matched.has(expectedIdx)) continue;
        const candidate = required[expectedIdx];
        if (call.name !== candidate.name) continue;
        if (!paramsMatch(candidate.name, candidate.params, call.args)) continue;
        matched.add(expectedIdx);
        break;
      }
      if (matched.size === requiredCount) {
        endIndex += 1;
        break;
      }
    }

    const roundCalls = actualCalls.slice(callOffset, Math.max(endIndex, callOffset + Math.max(requiredCount, 1)));

    if (roundCalls.length === 0 && requiredCount > 0) {
      errors.push(
        `Round ${roundIdx}: Expected ${requiredCount} tool call(s) [${expected.map((entry) => entry.name).join(', ')}] but no more calls were captured. Total captured: ${actualCalls.length}, consumed so far: ${callOffset}`,
      );
      continue;
    }

    for (const exp of expected) {
      if (exp.optional) continue;

      let matchIndex = roundCalls.findIndex((entry) => entry.name === exp.name && paramsMatch(exp.name, exp.params, entry.args));
      if (matchIndex === -1) {
        matchIndex = roundCalls.findIndex((entry) => entry.name === exp.name);
      }
      if (matchIndex === -1) {
        errors.push(
          `Round ${roundIdx}: Expected tool "${exp.name}" not found. Round calls: [${roundCalls.map((entry) => entry.name).join(', ')}]`,
        );
        continue;
      }

      const actualArgs = roundCalls[matchIndex].args;
      assertCliMetaArgs(exp.name, actualArgs, errors, prefixForRound(roundIdx));

      if (exp.params) {
        checkToolParams(exp.name, exp.params, actualArgs, errors, prefixForRound(roundIdx));
      }
    }

    callOffset += roundCalls.length;
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

export function assertTextContains(
  text: string,
  expectedPhrases: string[],
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

export function assertNoHallucinatedTools(
  actual: CapturedToolCall[],
  validToolNames: string[],
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

function checkToolParams(
  toolName: string,
  expectedParams: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
  errors: string[],
  prefix = '',
): void {
  if (toolName === 'getTools' && typeof expectedParams.tool === 'string') {
    const expectedSelectors = parseSelectors(expectedParams.tool);
    const actualSelectors = typeof actualArgs.tool === 'string' ? parseSelectors(actualArgs.tool) : [];

    const missing = expectedSelectors.filter((expected) => !actualSelectors.some((actual) => {
      if (actual.agent !== expected.agent) return false;
      if (!expected.tool) return true;
      return actual.tool === expected.tool;
    }));

    if (missing.length > 0) {
      errors.push(
        `${prefix}tool "${toolName}": expected selectors [${expectedSelectors.map(formatSelector).join(', ')}] but got [${actualSelectors.map(formatSelector).join(', ')}], missing: [${missing.map(formatSelector).join(', ')}]`,
      );
    }
    return;
  }

  if (toolName === 'useTools' && typeof expectedParams.tool === 'string') {
    const expectedCommands = parseCommands(expectedParams.tool);
    const actualCommands = typeof actualArgs.tool === 'string' ? parseCommands(actualArgs.tool) : [];

    const missing = expectedCommands.filter((expected) => !actualCommands.some((actual) =>
      actual.agent === expected.agent && actual.tool === expected.tool,
    ));

    if (missing.length > 0) {
      errors.push(
        `${prefix}tool "${toolName}": expected command prefixes [${expectedCommands.map(formatSelector).join(', ')}] but got [${actualCommands.map(formatSelector).join(', ')}], missing: [${missing.map(formatSelector).join(', ')}]`,
      );
    }
    return;
  }

  for (const [key, expectedValue] of Object.entries(expectedParams)) {
    if (!(key in actualArgs)) {
      errors.push(
        `${prefix}tool "${toolName}": expected param "${key}" not found in args ${JSON.stringify(actualArgs)}`,
      );
    } else if (!deepPartialMatch(actualArgs[key], expectedValue)) {
      errors.push(
        `${prefix}tool "${toolName}": param "${key}" expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualArgs[key])}`,
      );
    }
  }
}

function deepPartialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) {
    return true;
  }

  if (typeof expected !== 'object' || expected === null) {
    if (typeof expected === 'string' && typeof actual === 'string') {
      return actual.toLowerCase().includes(expected.toLowerCase());
    }
    return actual === expected;
  }

  if (typeof actual !== 'object' || actual === null) {
    return false;
  }

  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (!deepPartialMatch((actual as Record<string, unknown>)[key], value)) {
      return false;
    }
  }

  return true;
}
