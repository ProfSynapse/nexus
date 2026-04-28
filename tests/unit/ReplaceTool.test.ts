/**
 * ReplaceTool Unit Tests
 *
 * Tests the replace tool's content validation, sliding-window search,
 * CRLF normalization, delete mode, and diff output.
 */

import { ReplaceTool } from '../../src/agents/contentManager/tools/replace';
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

describe('ReplaceTool', () => {
  let tool: ReplaceTool;
  let app: MockApp;

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

    it('handles CRLF file content — single-line match succeeds', async () => {
      // Simulate vault.read() returning CRLF content (Windows-style line endings)
      mockFileContent = 'line 1\r\nline 2\r\nline 3';
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
      // Write-back content should be LF-only (CRLF stripped on read)
      expect(mockFileContent).toBe('line 1\nCHANGED\nline 3');
    });

    it('handles CRLF file content — multi-line match succeeds', async () => {
      mockFileContent = 'a\r\nb\r\nc\r\nd';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'b\nc',
        newContent: 'X\nY\nZ',
        startLine: 2,
        endLine: 3,
      });

      expect(result.success).toBe(true);
      expect(result.linesDelta).toBe(1);
      expect(mockFileContent).toBe('a\nX\nY\nZ\nd');
    });

    it('handles CRLF file content — findContentInLines fallback reports correct location', async () => {
      // Content at wrong startLine triggers sliding-window search
      mockFileContent = 'header\r\nTARGET\r\nfooter';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'TARGET',
        newContent: 'REPLACED',
        startLine: 1,  // Wrong line — content is actually at line 2
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Found at lines 2-2');
      expect(result.error).toContain('Retry with the correct line numbers');
    });

    it('strips lone CR characters from file content', async () => {
      // CR-only files (old Mac OS 9) have no \n at all — after stripping \r,
      // content collapses to a single line. This verifies CRs are removed so
      // they don't pollute line comparisons (the same mechanism that fixes CRLF).
      mockFileContent = 'abc\rdef';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'abcdef',  // CRs stripped → single line
        newContent: 'REPLACED',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('REPLACED');
    });

    it('LF file content — baseline behavior unchanged', async () => {
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
      expect(mockFileContent).toBe('line 1\nCHANGED\nline 3');
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
      const properties = (schema as SchemaLike).properties;

      expect(properties.oldContent.description).toContain('validated before any changes');
      expect(properties.newContent.description).toContain('empty string');
      expect(properties.startLine.description).toContain('1-indexed');
      expect(properties.endLine.description).toContain('inclusive');
    });

    it('requires all five parameters', () => {
      const schema = tool.getParameterSchema();
      const required = (schema as SchemaLike).required;

      expect(required).toContain('path');
      expect(required).toContain('oldContent');
      expect(required).toContain('newContent');
      expect(required).toContain('startLine');
      expect(required).toContain('endLine');
    });

    it('result schema includes diff, totalLines, linesDelta', () => {
      const schema = tool.getResultSchema();
      const properties = (schema as SchemaLike).properties;

      expect(properties.diff).toBeDefined();
      expect(properties.totalLines).toBeDefined();
      expect(properties.linesDelta).toBeDefined();
    });

    it('tool description mentions validation and line numbers', () => {
      expect(tool.description).toContain('Validates');
      expect(tool.description).toContain('line numbers');
    });
  });

  // ========================================================================
  // Unicode normalization (CODE-NexusReplaceF2Recurrence / issue #XXX)
  //
  // F2 was first reported 2026-04-24 and re-reproduced 2026-04-25 in a file
  // with no escaped backticks (only PT-BR accents). Pre-fix, the comparator at
  // replace.ts:147 ran a strict byte-equality check after CRLF normalization
  // only — visually identical strings differing only in Unicode normalization
  // form (NFC vs NFD) failed silently with "Content not found", forcing the
  // operator to escalate to overwrite (which violates the minimum-edit rule).
  //
  // This block proves the class exists and pins the new tolerance contract:
  // replace MUST treat NFC and NFD forms of the same code points as equal,
  // both for the line-range check and for the sliding-window fallback.
  // ========================================================================
  describe('Unicode normalization tolerance', () => {
    // Both lines render identically as "O pedido (e.3) é defensiva: cogita a
    // hipótese" — the bytes differ. We use explicit escape sequences for the
    // NFD line so that no editor / Prettier pass / git filter can quietly re-
    // compose it into NFC and turn the tests below into tautologies.
    //   NFC: é = U+00E9, ó = U+00F3                (one code point each)
    //   NFD: é = U+0065 U+0301, ó = U+006F U+0301  (base + combining acute)
    const NFC_LINE = 'O pedido (e.3) é defensiva: cogita a hipótese';
    const NFD_LINE = 'O pedido (e.3) \u0065\u0301 defensiva: cogita a hip\u006F\u0301tese';

    it('test fixtures are byte-distinct (sanity)', () => {
      // If this fails, the constants above have been collapsed to the same
      // Unicode form — every test in this block would then reduce to NFC===NFC
      // and silently pass even if the comparator's NFC tolerance regresses.
      expect(NFC_LINE).not.toBe(NFD_LINE);
      expect(NFC_LINE.normalize('NFC')).toBe(NFD_LINE.normalize('NFC'));
    });

    it('matches when file is NFC and oldContent is NFD (real-world repro)', async () => {
      mockFileContent = `head\n${NFC_LINE}\ntail`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: NFD_LINE,
        newContent: 'O pedido (e.3) tem natureza defensiva.',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('head\nO pedido (e.3) tem natureza defensiva.\ntail');
    });

    it('matches when file is NFD and oldContent is NFC (inverse drift)', async () => {
      mockFileContent = `head\n${NFD_LINE}\ntail`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: NFC_LINE,
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('head\nCHANGED\ntail');
    });

    it('finds NFD oldContent at NFC location via sliding-window fallback', async () => {
      // Caller provides wrong startLine/endLine; sliding-window must still
      // recover the location even with normalization-form drift.
      mockFileContent = `head\nfiller\n${NFC_LINE}\ntail`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: NFD_LINE,
        newContent: 'CHANGED',
        startLine: 1,
        endLine: 1,
      });

      // Either the fallback recovers (preferred), or it reports the correct
      // line. Both are acceptable; what is NOT acceptable is "Content not
      // found anywhere in the note" — that's the F2 silent failure.
      if (result.success === false) {
        expect(result.error).toContain('Found at lines 3-3');
      } else {
        // If your fix routes the comparator through a normalize step before
        // the line-range check too, the operation succeeds outright.
        expect(mockFileContent).toBe('head\nfiller\nCHANGED\ntail');
      }
    });

    it('multi-line oldContent with mixed normalization matches', async () => {
      mockFileContent = `${NFC_LINE}\nsegunda linha com ação\nterceira`;
      const oldContent = `${NFD_LINE}\nsegunda linha com ação`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent,
        newContent: 'BLOCO REESCRITO',
        startLine: 1,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('BLOCO REESCRITO\nterceira');
    });

    it('regression: truly-absent oldContent still fails with Content not found', async () => {
      // The fix must not accidentally make every replace succeed. Content
      // that genuinely does not exist (in any normalization) must still be
      // reported as missing.
      mockFileContent = `head\n${NFC_LINE}\ntail`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'this string is genuinely not in the file',
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content not found');
    });

    it('regression: ASCII-only content unchanged by normalization step', async () => {
      // No accented chars → NFC normalization is a no-op. Confirms the fix
      // is non-disruptive for the common case.
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
      expect(mockFileContent).toBe('line 1\nCHANGED\nline 3');
    });
  });

  describe('Unicode compatibility normalization tolerance', () => {
    const cases = [
      {
        name: 'masculine ordinal indicator',
        fileLine: 'A multa do art. 1.026, §2º do CPC',
        oldContent: 'A multa do art. 1.026, §2o do CPC',
      },
      {
        name: 'feminine ordinal indicator',
        fileLine: 'A 1ª instância julgou o pedido',
        oldContent: 'A 1a instância julgou o pedido',
      },
      {
        name: 'ellipsis',
        fileLine: 'A parte deve… pagar',
        oldContent: 'A parte deve... pagar',
      },
      {
        name: 'non-breaking space',
        fileLine: 'valor\u00A0devido',
        oldContent: 'valor devido',
      },
    ];

    it.each(cases)('matches compatibility-normalized oldContent for $name', async ({ fileLine, oldContent }) => {
      mockFileContent = `head\n${fileLine}\ntail`;
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent,
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe('head\nCHANGED\ntail');
    });

    it('finds compatibility-normalized content via sliding-window fallback', async () => {
      mockFileContent = 'head\nfiller\nA multa do art. 1.026, §2º do CPC\ntail';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'A multa do art. 1.026, §2o do CPC',
        newContent: 'CHANGED',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Found at lines 3-3');
      expect(mockFileContent).toBe('head\nfiller\nA multa do art. 1.026, §2º do CPC\ntail');
    });

    it('preserves untouched file bytes and writes newContent verbatim', async () => {
      const preservedPrefix = 'prefix com ordinal §2º';
      const replacement = 'novo texto com NBSP\u00A0preservado';
      mockFileContent = `${preservedPrefix}\nA parte deve… pagar\ntail`;

      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'A parte deve... pagar',
        newContent: replacement,
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(true);
      expect(mockFileContent).toBe(`${preservedPrefix}\n${replacement}\ntail`);
      expect(mockFileContent).toContain('§2º');
      expect(mockFileContent).toContain('\u00A0');
    });

    it('reports multiple locations for duplicate compatibility-equivalent matches', async () => {
      mockFileContent = '§2º\n§2o\nother';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: '§2o',
        newContent: 'CHANGED',
        startLine: 3,
        endLine: 3,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Found at multiple locations');
      expect(result.error).toContain('lines 1-1');
      expect(result.error).toContain('lines 2-2');
      expect(mockFileContent).toBe('§2º\n§2o\nother');
    });

    it('regression: genuinely absent compatibility-normalized content still fails', async () => {
      mockFileContent = 'head\nA parte deve… pagar\ntail';
      const result = await tool.execute({
        ...baseParams,
        path: 'test/note.md',
        oldContent: 'texto ausente',
        newContent: 'CHANGED',
        startLine: 2,
        endLine: 2,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Content not found');
      expect(mockFileContent).toBe('head\nA parte deve… pagar\ntail');
    });
  });
});
