/**
 * Unit tests for the unified diff utility.
 *
 * Tests the pure diff generation function that produces standard
 * unified diff output from two line arrays.
 */

import { generateUnifiedDiff } from '../../src/agents/contentManager/utils/unifiedDiff';

describe('generateUnifiedDiff', () => {
  function expectDefined<T>(value: T | null | undefined): T {
    expect(value).toBeDefined();
    return value as T;
  }

  // ========================================================================
  // No changes
  // ========================================================================

  it('returns empty string for identical content', () => {
    const lines = ['line 1', 'line 2', 'line 3'];
    expect(generateUnifiedDiff(lines, lines)).toBe('');
  });

  it('returns empty string for two empty arrays', () => {
    expect(generateUnifiedDiff([], [])).toBe('');
  });

  // ========================================================================
  // Single line changes
  // ========================================================================

  it('shows a single line replacement', () => {
    const oldLines = ['aaa', 'bbb', 'ccc'];
    const newLines = ['aaa', 'BBB', 'ccc'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('-bbb');
    expect(diff).toContain('+BBB');
    expect(diff).toContain(' aaa');
    expect(diff).toContain(' ccc');
    expect(diff).toMatch(/^@@/);
  });

  it('shows a single line insertion', () => {
    const oldLines = ['aaa', 'ccc'];
    const newLines = ['aaa', 'bbb', 'ccc'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('+bbb');
    expect(diff).toContain(' aaa');
    expect(diff).toContain(' ccc');
  });

  it('shows a single line deletion', () => {
    const oldLines = ['aaa', 'bbb', 'ccc'];
    const newLines = ['aaa', 'ccc'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('-bbb');
    expect(diff).toContain(' aaa');
    expect(diff).toContain(' ccc');
  });

  // ========================================================================
  // @@ header correctness
  // ========================================================================

  it('produces correct @@ header for a replacement in the middle', () => {
    const oldLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    //                  1    2    3    4    5    6    7    8    9    10
    // Replace line 5 (e → E)
    const newLines = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    // Hunk should start at line 2 with 3 context lines before line 5
    // old: starts at 2, spans 8 (lines 2-9: b,c,d,e,f,g,h,i — 3 before + 1 changed + 3 after + boundary)
    // We just check the header exists and has correct format
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('-e');
    expect(diff).toContain('+E');
  });

  it('produces correct counts when lines are added', () => {
    const oldLines = ['a', 'b', 'c'];
    const newLines = ['a', 'x', 'y', 'b', 'c'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    // Parse the header
    const match = diff.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    expect(match).not.toBeNull();
    if (match) {
      const oldCount = parseInt(match[2]);
      const newCount = parseInt(match[4]);
      // New count should be 2 more than old count (2 lines added)
      expect(newCount - oldCount).toBe(2);
    }
  });

  it('produces correct counts when lines are removed', () => {
    const oldLines = ['a', 'b', 'c', 'd', 'e'];
    const newLines = ['a', 'e'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    const match = diff.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    expect(match).not.toBeNull();
    if (match) {
      const oldCount = parseInt(match[2]);
      const newCount = parseInt(match[4]);
      // Old count should be 3 more than new count (3 lines removed)
      expect(oldCount - newCount).toBe(3);
    }
  });

  // ========================================================================
  // Context lines
  // ========================================================================

  it('respects default 3 context lines', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[10] = 'CHANGED'; // line 11

    const diff = generateUnifiedDiff(oldLines, newLines);

    // Should have 3 context lines before (lines 8,9,10) and 3 after (12,13,14)
    expect(diff).toContain(' line 8');
    expect(diff).toContain(' line 9');
    expect(diff).toContain(' line 10');
    expect(diff).toContain('-line 11');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' line 12');
    expect(diff).toContain(' line 13');
    expect(diff).toContain(' line 14');
    // Should NOT include lines far away
    expect(diff).not.toContain(' line 1\n');
    expect(diff).not.toContain(' line 20');
  });

  it('respects custom context lines', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[10] = 'CHANGED';

    const diff = generateUnifiedDiff(oldLines, newLines, 1);

    // Only 1 context line before and after
    expect(diff).toContain(' line 10');
    expect(diff).toContain('-line 11');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' line 12');
    // Should NOT have line 9 or line 13
    expect(diff).not.toContain(' line 9');
    expect(diff).not.toContain(' line 13');
  });

  it('clamps context at file start', () => {
    const oldLines = ['a', 'b', 'c'];
    const newLines = ['A', 'b', 'c'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    // Change is at line 1, so no context before it
    expect(diff).toContain('-a');
    expect(diff).toContain('+A');
    expect(diff).toContain(' b');
  });

  it('clamps context at file end', () => {
    const oldLines = ['a', 'b', 'c'];
    const newLines = ['a', 'b', 'C'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    // Change is at last line, so no context after it
    expect(diff).toContain(' b');
    expect(diff).toContain('-c');
    expect(diff).toContain('+C');
  });

  // ========================================================================
  // Multiple hunks
  // ========================================================================

  it('produces separate hunks for distant changes', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = 'CHANGED_2';  // line 2
    newLines[18] = 'CHANGED_19'; // line 19

    const diff = generateUnifiedDiff(oldLines, newLines);

    // Should have two @@ headers since the changes are far apart
    const headers = diff.match(/@@ .+? @@/g);
    expect(headers).not.toBeNull();
    expect(expectDefined(headers).length).toBe(2);

    expect(diff).toContain('-line 2');
    expect(diff).toContain('+CHANGED_2');
    expect(diff).toContain('-line 19');
    expect(diff).toContain('+CHANGED_19');
  });

  it('merges nearby changes into a single hunk', () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[2] = 'CHANGED_3'; // line 3
    newLines[4] = 'CHANGED_5'; // line 5

    const diff = generateUnifiedDiff(oldLines, newLines);

    // Only 1 line gap between changes — should be one hunk
    const headers = diff.match(/@@ .+? @@/g);
    expect(headers).not.toBeNull();
    expect(expectDefined(headers).length).toBe(1);
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  it('handles empty old content (new file)', () => {
    const oldLines: string[] = [''];
    const newLines = ['hello', 'world'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('handles single-line file', () => {
    const oldLines = ['only line'];
    const newLines = ['changed line'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('-only line');
    expect(diff).toContain('+changed line');
  });

  it('handles multi-line replacement with different line count', () => {
    const oldLines = ['a', 'b', 'c', 'd', 'e'];
    const newLines = ['a', 'x', 'y', 'z', 'w', 'v', 'e'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    expect(diff).toContain('-b');
    expect(diff).toContain('-c');
    expect(diff).toContain('-d');
    expect(diff).toContain('+x');
    expect(diff).toContain('+y');
    expect(diff).toContain('+z');
    expect(diff).toContain('+w');
    expect(diff).toContain('+v');
  });

  // ========================================================================
  // Line prefix format
  // ========================================================================

  it('prefixes unchanged lines with space', () => {
    const oldLines = ['a', 'b', 'c'];
    const newLines = ['a', 'B', 'c'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    const lines = diff.split('\n');
    const contextLines = lines.filter(l => l.startsWith(' '));
    expect(contextLines.length).toBeGreaterThanOrEqual(2); // 'a' and 'c'
  });

  it('prefixes removed lines with minus', () => {
    const oldLines = ['a', 'b', 'c'];
    const newLines = ['a', 'c'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    const lines = diff.split('\n');
    const removedLines = lines.filter(l => l.startsWith('-'));
    expect(removedLines).toContain('-b');
  });

  it('prefixes added lines with plus', () => {
    const oldLines = ['a', 'c'];
    const newLines = ['a', 'b', 'c'];
    const diff = generateUnifiedDiff(oldLines, newLines);

    const lines = diff.split('\n');
    const addedLines = lines.filter(l => l.startsWith('+'));
    expect(addedLines).toContain('+b');
  });
});
