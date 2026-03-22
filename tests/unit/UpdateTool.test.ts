/**
 * UpdateTool Unit Tests
 *
 * Tests the update tool's diff output, totalLines, and linesDelta
 * across all operation modes (insert, replace, delete, append).
 */

import { UpdateTool } from '../../src/agents/contentManager/tools/update';
import { TFile } from 'obsidian';

// ============================================================================
// Mock setup
// ============================================================================

let mockFileContent = '';
// Use the mock TFile class so instanceof checks pass
const mockFile = new TFile('note.md', 'test/note.md');

function createMockApp(fileExists = true) {
  return {
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(fileExists ? mockFile : null),
      read: jest.fn().mockImplementation(async () => mockFileContent),
      modify: jest.fn().mockImplementation(async (_file: TFile, content: string) => {
        mockFileContent = content;
      }),
    },
    workspace: {},
  } as any;
}

const baseParams = {
  context: { workspaceId: 'ws-1', sessionId: 'sess-1', memory: '', goal: 'test' },
};

describe('UpdateTool', () => {
  let tool: UpdateTool;
  let app: any;

  beforeEach(() => {
    app = createMockApp();
    tool = new UpdateTool(app);
    mockFileContent = '';
  });

  // ========================================================================
  // Result structure
  // ========================================================================

  describe('result structure', () => {
    it('returns totalLines on success', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'new line 2',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(3);
    });

    it('returns diff string on success', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.diff).toBeDefined();
      expect(result.diff).toContain('-line 2');
      expect(result.diff).toContain('+CHANGED');
    });

    it('returns linesDelta on success', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.linesDelta).toBe(0);
    });

    it('does not return diff on error', async () => {
      app = createMockApp(false);
      tool = new UpdateTool(app);

      const result = await tool.execute({
        ...baseParams,
        path: 'nonexistent.md',
        content: 'test',
        startLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.diff).toBeUndefined();
    });
  });

  // ========================================================================
  // INSERT mode
  // ========================================================================

  describe('INSERT mode', () => {
    it('inserts a single line and returns diff', async () => {
      mockFileContent = 'line 1\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'line 2',
        startLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(1);
      expect(result.totalLines).toBe(3);
      expect(result.diff).toContain('+line 2');
    });

    it('inserts multiple lines and returns correct delta', async () => {
      mockFileContent = 'a\nd';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'b\nc',
        startLine: 2,
      });

      expect(result.linesDelta).toBe(2);
      expect(result.totalLines).toBe(4);
      expect(result.diff).toContain('+b');
      expect(result.diff).toContain('+c');
    });

    it('diff shows context around insertion', async () => {
      mockFileContent = 'a\nb\nc\nd\ne\nf\ng\nh';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'NEW',
        startLine: 5,
      });

      expect(result.diff).toContain(' c');
      expect(result.diff).toContain(' d');
      expect(result.diff).toContain('+NEW');
      expect(result.diff).toContain(' e');
      expect(result.diff).toContain(' f');
    });
  });

  // ========================================================================
  // REPLACE mode
  // ========================================================================

  describe('REPLACE mode', () => {
    it('replaces a single line with same-length content', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'B',
        startLine: 2,
        endLine: 2,
      });

      expect(result.linesDelta).toBe(0);
      expect(result.totalLines).toBe(3);
      expect(result.diff).toContain('-b');
      expect(result.diff).toContain('+B');
    });

    it('replaces a range with more lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'x\ny\nz\nw',
        startLine: 2,
        endLine: 3,
      });

      // Removed 2 lines, added 4 → delta = +2
      expect(result.linesDelta).toBe(2);
      expect(result.totalLines).toBe(7);
      expect(result.diff).toContain('-b');
      expect(result.diff).toContain('-c');
      expect(result.diff).toContain('+x');
      expect(result.diff).toContain('+y');
      expect(result.diff).toContain('+z');
      expect(result.diff).toContain('+w');
    });

    it('replaces a range with fewer lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'X',
        startLine: 2,
        endLine: 4,
      });

      // Removed 3 lines, added 1 → delta = -2
      expect(result.linesDelta).toBe(-2);
      expect(result.totalLines).toBe(3);
    });

    it('diff @@ header reflects new line numbers', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'x\ny\nz',
        startLine: 2,
        endLine: 2,
      });

      // Verify the @@ header contains correct new-side count
      const match = result.diff?.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      expect(match).not.toBeNull();
      if (match) {
        const newCount = parseInt(match[4]);
        const oldCount = parseInt(match[2]);
        expect(newCount - oldCount).toBe(2); // added 2 net lines
      }
    });
  });

  // ========================================================================
  // DELETE mode
  // ========================================================================

  describe('DELETE mode', () => {
    it('deletes a single line', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: '',
        startLine: 2,
        endLine: 2,
      });

      expect(result.linesDelta).toBe(-1);
      expect(result.totalLines).toBe(2);
      expect(result.diff).toContain('-b');
    });

    it('deletes a range of lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: '',
        startLine: 2,
        endLine: 4,
      });

      expect(result.linesDelta).toBe(-3);
      expect(result.totalLines).toBe(2);
      expect(result.diff).toContain('-b');
      expect(result.diff).toContain('-c');
      expect(result.diff).toContain('-d');
    });
  });

  // ========================================================================
  // APPEND mode
  // ========================================================================

  describe('APPEND mode', () => {
    it('appends content and returns diff', async () => {
      mockFileContent = 'line 1\nline 2';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'line 3',
        startLine: -1,
      });

      expect(result.success).toBe(true);
      expect(result.totalLines).toBe(3);
      expect(result.diff).toContain('+line 3');
    });

    it('appends multi-line content', async () => {
      mockFileContent = 'a';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'b\nc\nd',
        startLine: -1,
      });

      expect(result.totalLines).toBe(4);
      expect(result.linesDelta).toBe(3);
    });
  });

  // ========================================================================
  // Error cases (no diff returned)
  // ========================================================================

  describe('error cases', () => {
    it('returns error for non-existent file', async () => {
      app = createMockApp(false);
      tool = new UpdateTool(app);

      const result = await tool.execute({
        ...baseParams,
        path: 'missing.md',
        content: 'test',
        startLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.diff).toBeUndefined();
      expect(result.totalLines).toBeUndefined();
    });

    it('returns error for invalid startLine', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 0,
      });

      expect(result.success).toBe(false);
    });

    it('returns error for startLine beyond file', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 100,
      });

      expect(result.success).toBe(false);
    });

    it('returns error for endLine < startLine', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 3,
        endLine: 1,
      });

      expect(result.success).toBe(false);
    });

    it('returns error for endLine beyond file', async () => {
      mockFileContent = 'line 1\nline 2';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 1,
        endLine: 100,
      });

      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // expectedContent (stale write prevention)
  // ========================================================================

  describe('expectedContent validation', () => {
    it('succeeds when expectedContent matches target lines', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'REPLACED',
        startLine: 2,
        endLine: 2,
        expectedContent: 'line 2',
      });

      expect(result.success).toBe(true);
      expect(result.diff).toContain('+REPLACED');
    });

    it('validates multi-line expectedContent for range replace', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'X\nY',
        startLine: 2,
        endLine: 3,
        expectedContent: 'b\nc',
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(0);
    });

    it('skips validation for append mode (startLine -1)', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'appended',
        startLine: -1,
        expectedContent: 'irrelevant',
      });

      expect(result.success).toBe(true);
    });

    it('skips validation when expectedContent is not provided', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'REPLACED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
    });

    it('skips validation for insert mode (no endLine)', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'NEW',
        startLine: 2,
        expectedContent: 'wrong content',
      });

      expect(result.success).toBe(true);
    });

    it('normalizes CRLF in expectedContent', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'REPLACED',
        startLine: 2,
        endLine: 2,
        expectedContent: 'line 2\r\n',
      });

      // '\r\n' normalized to '\n' leaves trailing newline — won't match 'line 2'
      expect(result.success).toBe(false);
    });

    // ---- Smart error: content found at one location ----
    it('reports new line numbers when content shifted to one location', async () => {
      // Content 'b\nc' was at lines 2-3 but a new line was inserted before it
      mockFileContent = 'a\nNEW\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'X\nY',
        startLine: 2,
        endLine: 3,
        expectedContent: 'b\nc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content not found at lines 2-3');
      expect(result.error).toContain('Found at lines 3-4');
      expect(result.error).toContain('Please retry with updated line numbers');
    });

    // ---- Smart error: content found at multiple locations ----
    it('reports multiple locations when content appears more than once', async () => {
      mockFileContent = 'a\nb\nc\nd\nb\nc\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'X\nY',
        startLine: 1,
        endLine: 2,
        expectedContent: 'b\nc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content not found at lines 1-2');
      expect(result.error).toContain('Found at multiple locations');
      expect(result.error).toContain('lines 2-3');
      expect(result.error).toContain('lines 5-6');
    });

    // ---- Smart error: content not found anywhere ----
    it('reports content does not exist when not found anywhere', async () => {
      mockFileContent = 'line 1\nACTUAL LINE 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'REPLACED',
        startLine: 2,
        endLine: 2,
        expectedContent: 'old line 2',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content not found at lines 2-2');
      expect(result.error).toContain('does not exist in the note');
    });
  });

  // ========================================================================
  // Schema
  // ========================================================================

  describe('schema', () => {
    it('result schema includes diff and totalLines', () => {
      const schema = tool.getResultSchema();
      const properties = (schema as any).properties;

      expect(properties.diff).toBeDefined();
      expect(properties.totalLines).toBeDefined();
      expect(properties.linesDelta).toBeDefined();
    });

    it('tool description mentions diff', () => {
      expect(tool.description).toContain('diff');
    });
  });
});
