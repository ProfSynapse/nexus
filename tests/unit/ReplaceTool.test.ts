/**
 * ReplaceTool Smoke Tests
 *
 * Minimum smoke coverage for the pattern-anchored replace schema (path, start,
 * end, content). Comprehensive scenario coverage is owned by the TEST phase
 * (test-engineer). The NFKC drift case is preserved here as a smoke anchor
 * since the intent (PR #184) survives the schema break: anchors must still
 * tolerate Unicode compatibility drift between the LLM-authored payload and
 * the file bytes.
 */

import { ReplaceTool } from '../../src/agents/contentManager/tools/replace';
import { App, TFile } from 'obsidian';

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

describe('ReplaceTool (pattern anchors)', () => {
  let tool: ReplaceTool;
  let app: MockApp;

  beforeEach(() => {
    app = createMockApp();
    tool = new ReplaceTool(app);
    mockFileContent = '';
  });

  it('replaces a range between two unique anchors', async () => {
    mockFileContent = 'alpha\nbeta\ngamma\ndelta\nepsilon';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'beta',
      end: 'delta',
      content: 'REPLACED',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('alpha\nREPLACED\nepsilon');
  });

  it('deletes the range when content is empty', async () => {
    mockFileContent = 'alpha\nbeta\ngamma\ndelta\nepsilon';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'beta',
      end: 'delta',
      content: '',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('alpha\nepsilon');
    expect(result.linesDelta).toBeLessThan(0);
  });

  it('errors when start anchor is not found', async () => {
    mockFileContent = 'alpha\nbeta\ngamma';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'missing',
      end: 'gamma',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('start anchor not found');
  });

  it('errors when start anchor matches multiple lines and lists them', async () => {
    mockFileContent = 'foo\nbar\nfoo\nbaz';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'foo',
      end: 'baz',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('start anchor matches 2 locations');
    expect(result.error).toContain('lines [1, 3]');
  });

  it('errors when end anchor matches multiple lines', async () => {
    mockFileContent = 'start-here\nfoo\nend\nbar\nend';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'start-here',
      end: 'end',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('end anchor matches 2 locations');
  });

  it('errors when end appears before start', async () => {
    mockFileContent = 'tail\nmiddle\nhead';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'head',
      end: 'tail',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('right order');
  });

  it('resolves multi-line start anchor', async () => {
    mockFileContent = '## Header\nLast updated: today\nbody-1\nbody-2\nFooter';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: '## Header\nLast updated: today',
      end: 'Footer',
      content: 'REWRITTEN',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('REWRITTEN');
  });

  it('rejects empty/whitespace anchors', async () => {
    mockFileContent = 'alpha\nbeta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: '   ',
      end: 'beta',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-whitespace');
  });

  it('errors when file does not exist', async () => {
    app = createMockApp(false);
    tool = new ReplaceTool(app);
    const result = await tool.execute({
      ...baseParams,
      path: 'missing.md',
      start: 'a',
      end: 'b',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  // NFKC drift smoke (PR #184 intent — anchor text in a different Unicode
  // normalization form than the file bytes must still match).
  it('tolerates NFKC compatibility drift in anchors', async () => {
    mockFileContent = 'head\nA 1ª instância julgou o pedido\ntail';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      // LLM typed plain ASCII; file has the compatibility form.
      start: 'A 1a instância julgou o pedido',
      end: 'A 1a instância julgou o pedido',
      content: 'CHANGED',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('head\nCHANGED\ntail');
  });

  it('preserves CRLF-free output and returns linesDelta', async () => {
    mockFileContent = 'a\nb\nc\nd';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'b',
      end: 'c',
      content: 'X\nY\nZ',
    });

    expect(result.success).toBe(true);
    expect(result.linesDelta).toBe(1);
    expect(mockFileContent).toBe('a\nX\nY\nZ\nd');
  });

  it('exposes the new 4-field schema', () => {
    const schema = tool.getParameterSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['path', 'start', 'end', 'content']));
    expect(schema.required).toEqual(expect.arrayContaining(['path', 'start', 'end', 'content']));
    expect(schema.properties).not.toHaveProperty('oldContent');
    expect(schema.properties).not.toHaveProperty('newContent');
    expect(schema.properties).not.toHaveProperty('startLine');
    expect(schema.properties).not.toHaveProperty('endLine');
  });
});
