/**
 * InsertTool Unit Tests
 *
 * Tests the insert tool's positional insert, prepend, append,
 * multi-line insert, and boundary validation.
 */

import { InsertTool } from '../../src/agents/contentManager/tools/insert';
import { App, TFile } from 'obsidian';

// ============================================================================
// Mock setup
// ============================================================================

let mockFileContent = '';
const mockFile = new TFile('note.md', 'test/note.md');

type MockApp = App & {
  vault: {
    getAbstractFileByPath: jest.Mock<TFile | null, [string]>;
    read: jest.Mock<Promise<string>, [TFile]>;
    modify: jest.Mock<Promise<void>, [TFile, string]>;
  };
  workspace: Record<string, never>;
};

type SchemaLike = {
  properties: Record<string, { description?: string }>;
  required: string[];
};

function createMockApp(fileExists = true): MockApp {
  return {
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(fileExists ? mockFile : null),
      read: jest.fn().mockImplementation(async () => mockFileContent),
      modify: jest.fn().mockImplementation(async (_file: TFile, content: string) => {
        mockFileContent = content;
      }),
    },
    workspace: {},
  } as unknown as MockApp;
}

const baseParams = {
  context: { workspaceId: 'ws-1', sessionId: 'sess-1', memory: '', goal: 'test' },
};

describe('InsertTool', () => {
  let tool: InsertTool;
  let app: MockApp;

  beforeEach(() => {
    app = createMockApp();
    tool = new InsertTool(app);
    mockFileContent = '';
  });

  // ========================================================================
  // INSERT at position
  // ========================================================================

  describe('INSERT at position', () => {
    it('inserts a single line at position N', async () => {
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
      expect(mockFileContent).toBe('line 1\nline 2\nline 3');
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
      expect(mockFileContent).toBe('a\nb\nc\nd');
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
  // PREPEND (startLine = 1)
  // ========================================================================

  describe('PREPEND mode', () => {
    it('prepends content at start of file', async () => {
      mockFileContent = 'existing line';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'first line',
        startLine: 1,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(1);
      expect(result.totalLines).toBe(2);
      expect(mockFileContent).toBe('first line\nexisting line');
    });
  });

  // ========================================================================
  // APPEND (startLine = -1)
  // ========================================================================

  describe('APPEND mode', () => {
    it('appends content to end of file', async () => {
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
      expect(mockFileContent).toBe('line 1\nline 2\nline 3');
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
      expect(mockFileContent).toBe('a\nb\nc\nd');
    });

    it('adds newline before append when file does not end with one', async () => {
      mockFileContent = 'no trailing newline';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'appended',
        startLine: -1,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('no trailing newline\nappended');
    });

    it('does not add extra newline when file ends with one', async () => {
      mockFileContent = 'with trailing newline\n';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'appended',
        startLine: -1,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('with trailing newline\nappended');
    });
  });

  // ========================================================================
  // Boundary validation
  // ========================================================================

  describe('boundary validation', () => {
    it('rejects startLine beyond file length + 1', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('beyond file length');
    });

    it('allows insert at totalLines + 1 (after last line)', async () => {
      mockFileContent = 'line 1\nline 2';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'line 3',
        startLine: 3,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('line 1\nline 2\nline 3');
    });

    it('rejects startLine 0', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid startLine');
    });

    it('rejects negative startLine other than -1', async () => {
      mockFileContent = 'line 1';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        content: 'test',
        startLine: -5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid startLine');
    });

    it('returns error for non-existent file', async () => {
      app = createMockApp(false);
      tool = new InsertTool(app);

      const result = await tool.execute({
        ...baseParams,
        path: 'missing.md',
        content: 'test',
        startLine: 1,
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
      const properties = (schema as SchemaLike).properties;

      expect(properties.content.description).toContain('multi-line');
      expect(properties.startLine.description).toContain('-1');
      expect(properties.startLine.description).toContain('append');
      expect(properties.startLine.description).toContain('prepend');
    });

    it('requires path, content, and startLine', () => {
      const schema = tool.getParameterSchema();
      const required = (schema as SchemaLike).required;

      expect(required).toContain('path');
      expect(required).toContain('content');
      expect(required).toContain('startLine');
    });

    it('result schema includes diff, totalLines, linesDelta', () => {
      const schema = tool.getResultSchema();
      const properties = (schema as SchemaLike).properties;

      expect(properties.diff).toBeDefined();
      expect(properties.totalLines).toBeDefined();
      expect(properties.linesDelta).toBeDefined();
    });

    it('tool description distinguishes from replace', () => {
      expect(tool.description).toContain('Insert');
      expect(tool.description).toContain('replace tool');
    });
  });
});
