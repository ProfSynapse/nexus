/**
 * ReplaceTool Unit Tests
 *
 * Tests the replace tool's content validation, sliding-window search,
 * CRLF normalization, delete mode, and diff output.
 */

import { ReplaceTool } from '../../src/agents/contentManager/tools/replace';
import { TFile } from 'obsidian';

// ============================================================================
// Mock setup
// ============================================================================

let mockFileContent = '';
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

describe('ReplaceTool', () => {
  let tool: ReplaceTool;
  let app: any;

  beforeEach(() => {
    app = createMockApp();
    tool = new ReplaceTool(app);
    mockFileContent = '';
  });

  // ========================================================================
  // Successful replacement
  // ========================================================================

  describe('successful replacement', () => {
    it('replaces content at correct lines', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'line 2',
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(0);
      expect(result.totalLines).toBe(3);
      expect(result.diff).toContain('-line 2');
      expect(result.diff).toContain('+CHANGED');
      expect(mockFileContent).toBe('line 1\nCHANGED\nline 3');
    });

    it('replaces a multi-line range with more lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b\nc',
        newContent: 'x\ny\nz\nw',
        startLine: 2,
        endLine: 3,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(2);
      expect(result.totalLines).toBe(7);
      expect(mockFileContent).toBe('a\nx\ny\nz\nw\nd\ne');
    });

    it('replaces a range with fewer lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b\nc\nd',
        newContent: 'X',
        startLine: 2,
        endLine: 4,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(-2);
      expect(result.totalLines).toBe(3);
      expect(mockFileContent).toBe('a\nX\ne');
    });

    it('returns diff with @@ header', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b',
        newContent: 'x\ny\nz',
        startLine: 2,
        endLine: 2,
      });

      expect(result.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    });
  });

  // ========================================================================
  // Delete mode (newContent = "")
  // ========================================================================

  describe('delete mode', () => {
    it('deletes a single line when newContent is empty', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b',
        newContent: '',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(-1);
      expect(result.totalLines).toBe(2);
      expect(result.diff).toContain('-b');
      expect(mockFileContent).toBe('a\nc');
    });

    it('deletes a range of lines', async () => {
      mockFileContent = 'a\nb\nc\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b\nc\nd',
        newContent: '',
        startLine: 2,
        endLine: 4,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(-3);
      expect(result.totalLines).toBe(2);
      expect(mockFileContent).toBe('a\ne');
    });
  });

  // ========================================================================
  // Content mismatch — sliding window search
  // ========================================================================

  describe('content mismatch with search', () => {
    it('reports correct lines when content found at one other location', async () => {
      mockFileContent = 'a\nb\nTARGET\nd\ne';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'TARGET',
        newContent: 'REPLACED',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Found at lines 3-3');
      expect(result.error).toContain('Retry with the correct line numbers');
    });

    it('reports multiple locations when content found at several places', async () => {
      mockFileContent = 'TARGET\na\nTARGET\nb\nTARGET';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'TARGET',
        newContent: 'REPLACED',
        startLine: 4,
        endLine: 4,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('multiple locations');
      expect(result.error).toContain('lines 1-1');
      expect(result.error).toContain('lines 3-3');
      expect(result.error).toContain('lines 5-5');
    });

    it('reports content not found anywhere', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'NONEXISTENT',
        newContent: 'REPLACED',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found at lines 1-1 or anywhere else');
      expect(result.error).toContain('may have been modified or removed');
    });

    it('handles multi-line oldContent in sliding search', async () => {
      mockFileContent = 'a\nfoo\nbar\nc\nfoo\nbar\nd';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'foo\nbar',
        newContent: 'REPLACED',
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('multiple locations');
      expect(result.error).toContain('lines 2-3');
      expect(result.error).toContain('lines 5-6');
    });
  });

  // ========================================================================
  // CRLF normalization
  // ========================================================================

  describe('CRLF normalization', () => {
    it('normalizes CRLF in oldContent for comparison', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'line 2',  // LF only in oldContent
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
    });

    it('normalizes CRLF in multi-line oldContent', async () => {
      mockFileContent = 'a\nb\nc';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'a\r\nb',  // CRLF in oldContent
        newContent: 'X\nY',
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('X\nY\nc');
    });
  });

  // ========================================================================
  // Boundary validation
  // ========================================================================

  describe('boundary validation', () => {
    it('rejects startLine < 1', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'line 1',
        newContent: 'CHANGED',
        startLine: 0,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid startLine');
    });

    it('rejects negative startLine', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'line 1',
        newContent: 'CHANGED',
        startLine: -5,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid startLine');
    });

    it('rejects endLine < startLine', async () => {
      mockFileContent = 'line 1\nline 2\nline 3';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'test',
        newContent: 'CHANGED',
        startLine: 3,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be less than startLine');
    });

    it('rejects startLine beyond file length', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'test',
        newContent: 'CHANGED',
        startLine: 100,
        endLine: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('beyond file length');
    });

    it('rejects endLine beyond file length', async () => {
      mockFileContent = 'line 1\nline 2';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'line 1',
        newContent: 'CHANGED',
        startLine: 1,
        endLine: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('beyond file length');
    });

    it('returns error for non-existent file', async () => {
      app = createMockApp(false);
      tool = new ReplaceTool(app);

      const result = await tool.execute({
        ...baseParams,
        path: 'missing.md',
        oldContent: 'test',
        newContent: 'CHANGED',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });

  // ========================================================================
  // Schema
  // ========================================================================

  describe('schema', () => {
    it('has self-documenting parameter descriptions', () => {
      const schema = tool.getParameterSchema();
      const properties = (schema as any).properties;

      expect(properties.oldContent.description).toContain('validated before any changes');
      expect(properties.newContent.description).toContain('empty string');
      expect(properties.startLine.description).toContain('1-indexed');
      expect(properties.endLine.description).toContain('inclusive');
    });

    it('requires all five parameters', () => {
      const schema = tool.getParameterSchema();
      const required = (schema as any).required;

      expect(required).toContain('path');
      expect(required).toContain('oldContent');
      expect(required).toContain('newContent');
      expect(required).toContain('startLine');
      expect(required).toContain('endLine');
    });

    it('result schema includes diff, totalLines, linesDelta', () => {
      const schema = tool.getResultSchema();
      const properties = (schema as any).properties;

      expect(properties.diff).toBeDefined();
      expect(properties.totalLines).toBeDefined();
      expect(properties.linesDelta).toBeDefined();
    });

    it('tool description mentions validation and line numbers', () => {
      expect(tool.description).toContain('Validates');
      expect(tool.description).toContain('line numbers');
    });
  });
});
