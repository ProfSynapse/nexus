/**
 * ReplaceTool Tests — full 17-scenario matrix from plan §8 plus adversarial cases.
 *
 * Coverage map to docs/plans/replace-tool-anchor-redesign-plan.md §8:
 *   §8.1  unique start/end multi-line range
 *   §8.2  start === end single-line replace
 *   §8.3  start not found
 *   §8.4  end not found
 *   §8.5  start matches twice — lists line numbers
 *   §8.6  end matches twice (incl. before start) — lists line numbers
 *   §8.7  end before start (both unique) — order error with both line numbers
 *   §8.8  multi-line start anchor block
 *   §8.9  content === "" deletes range, linesDelta negative
 *   §8.10 NFKC drift tolerated
 *   §8.11 empty start — validation error
 *   §8.12 whitespace-only end — validation error
 *   §8.13 file not found
 *   §8.14 path is a folder
 *   §8.15 sequential edits in one batch (anchors against post-first-edit state)
 *   §8.16 identical start === end matches exactly once (explicit single-line)
 *   §8.17 multi-line start partial-overlap with end-block — end search is unbounded
 *
 * Adversarial cases beyond §8: non-adjacent ambiguous anchors, NFKC drift on
 * BOTH anchors simultaneously, anchors at file edges (first/last line), CRLF
 * input normalization, multi-line end anchor.
 */

import { ReplaceTool } from '../../src/agents/contentManager/tools/replace';
import { App, TFile, TFolder } from 'obsidian';

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

  it('§8.1: replaces a range between two unique anchors (multi-line range)', async () => {
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
    // M4 (post-review fold-in) — assert the canonical write primitive was
    // called exactly once with the expected file ref and content. Guards
    // against regressions that bypass `vault.modify` via `vault.adapter.write`
    // or similar and would otherwise still mutate `mockFileContent`.
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nREPLACED\nepsilon');
  });

  it('§8.9: deletes the range when content is empty and reports negative linesDelta', async () => {
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
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nepsilon');
  });

  it('§8.3: errors when start anchor is not found', async () => {
    mockFileContent = 'alpha\nbeta\ngamma';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'missing',
      end: 'gamma',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim message including re-read coaching suffix.
    expect(result.error).toBe(
      'start anchor not found in file. The content may have been edited since your last read — re-read the file and try again.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  // M1 (post-review fold-in) — an empty file with non-whitespace anchors must
  // fail with the start-not-found message and must NOT call vault.modify.
  it('§8.10b (M1): empty file with non-whitespace anchors returns "anchor not found" without writing', async () => {
    mockFileContent = '';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'anything',
      end: 'anything',
      content: 'should not be written',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'start anchor not found in file. The content may have been edited since your last read — re-read the file and try again.'
    );
    expect(mockFileContent).toBe('');
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('§8.5: errors when start anchor matches multiple lines and lists them', async () => {
    mockFileContent = 'foo\nbar\nfoo\nbaz';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'foo',
      end: 'baz',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim message with full extension coaching suffix.
    expect(result.error).toBe(
      'start anchor matches 2 locations: lines [1, 3]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('§8.6: errors when end anchor matches multiple lines (incl. before start)', async () => {
    mockFileContent = 'start-here\nfoo\nend\nbar\nend';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'start-here',
      end: 'end',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim for end-anchor ambiguity (end matches at lines 3, 5).
    expect(result.error).toBe(
      'end anchor matches 2 locations: lines [3, 5]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('§8.7: errors when end appears before start (both unique) and references both line numbers', async () => {
    mockFileContent = 'tail\nmiddle\nhead';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'head',
      end: 'tail',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim order-error message (E=1, S=3).
    expect(result.error).toBe(
      'end anchor is at line 1 but start anchor is at line 3 (3 > 1). Check that start and end are in the right order in the file.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('§8.8: resolves multi-line start anchor block', async () => {
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
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'REWRITTEN');
  });

  it('§8.11: rejects whitespace-only start anchor', async () => {
    mockFileContent = 'alpha\nbeta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: '   ',
      end: 'beta',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim non-whitespace validation message.
    expect(result.error).toBe(
      'start and end must contain non-whitespace text. Pick distinctive lines from your read.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  // M1 fold-in: split row 11 from row 12 so a regression that only breaks the
  // `end` half of the combined guard surfaces in its own test.
  it('§8.12: rejects whitespace-only end anchor', async () => {
    mockFileContent = 'alpha\nbeta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'alpha',
      end: '\t  \n  ',
      content: 'x',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'start and end must contain non-whitespace text. Pick distinctive lines from your read.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it('§8.13: errors when file does not exist', async () => {
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
    // M3 — plan §6 verbatim file-not-found message with path interpolation
    // and full storageManager/search content guidance suffix.
    expect(result.error).toBe(
      'File not found: "missing.md". Use search content to find files by name, or storageManager.list to explore folders.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  // NFKC drift smoke (PR #184 intent — anchor text in a different Unicode
  // normalization form than the file bytes must still match).
  it('§8.10: tolerates NFKC compatibility drift in anchors', async () => {
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
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'head\nCHANGED\ntail');
  });

  it('preserves CRLF-free output and returns positive linesDelta on growth', async () => {
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
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'a\nX\nY\nZ\nd');
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

  // ---------------------------------------------------------------------------
  // §8.2 — start === end (single-line replace)
  // ---------------------------------------------------------------------------
  it('§8.2: start === end performs a single-line replace', async () => {
    mockFileContent = 'alpha\nbeta\ngamma\ndelta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'gamma',
      end: 'gamma',
      content: 'GAMMA-REPLACED',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('alpha\nbeta\nGAMMA-REPLACED\ndelta');
    expect(result.linesDelta).toBe(0);
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nbeta\nGAMMA-REPLACED\ndelta');
  });

  // ---------------------------------------------------------------------------
  // §8.4 — end anchor not found (distinct from start not found)
  // ---------------------------------------------------------------------------
  it('§8.4: errors when end anchor is not found (start is unique)', async () => {
    mockFileContent = 'alpha\nbeta\ngamma\ndelta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'beta',
      end: 'nonexistent-marker',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim end-not-found message. Note: this assertion is the
    // sole guard that the start-anchor message variant is NOT emitted when
    // start resolved but end did not (avoids LLM-confusing message mix).
    expect(result.error).toBe(
      'end anchor not found in file. The content may have been edited since your last read — re-read the file and try again.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // §8.14 — path is a folder, not a file
  // ---------------------------------------------------------------------------
  it('§8.14: errors when path resolves to a folder', async () => {
    const folder = Object.create(TFolder.prototype) as TFolder;
    Object.assign(folder, { path: 'some/folder', name: 'folder' });
    const folderApp = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(folder),
        read: jest.fn(),
        modify: jest.fn(),
      },
      workspace: {},
    } as unknown as MockApp;
    const folderTool = new ReplaceTool(folderApp);

    const result = await folderTool.execute({
      ...baseParams,
      path: 'some/folder',
      start: 'beta',
      end: 'gamma',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim path-is-a-folder message with path interpolation
    // and the storageManager.list guidance suffix.
    expect(result.error).toBe(
      'Path is a folder, not a file: "some/folder". Use storageManager.list to see its contents.'
    );
    expect(folderApp.vault.read).not.toHaveBeenCalled();
    expect(folderApp.vault.modify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // §8.15 — sequential edits in one batch (5-step batch, T-F1 fold-in)
  //   Five tool.execute() calls in sequence on the same file. Each step uses
  //   an anchor that ONLY exists because the previous step's content was
  //   inserted. This proves per-step anchor re-resolution against the evolving
  //   buffer (rather than against any cached pre-batch line-number model) and
  //   catches state-corruption regressions if batch semantics change.
  // ---------------------------------------------------------------------------
  it('§8.15: sequential edits — 5-step batch, each step anchors against post-prior-step content', async () => {
    mockFileContent = 'header\nold-block-A\nmiddle\nold-block-B\nfooter';

    // Step 1: rename old-block-A → STEP1.
    const r1 = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'old-block-A',
      end: 'old-block-A',
      content: 'STEP1',
    });
    expect(r1.success).toBe(true);
    expect(mockFileContent).toBe('header\nSTEP1\nmiddle\nold-block-B\nfooter');

    // Step 2: rename old-block-B → STEP2. Independent of step 1.
    const r2 = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'old-block-B',
      end: 'old-block-B',
      content: 'STEP2',
    });
    expect(r2.success).toBe(true);
    expect(mockFileContent).toBe('header\nSTEP1\nmiddle\nSTEP2\nfooter');

    // Step 3: collapse [STEP1..STEP2] range into STEP3. Anchors STEP1 + STEP2
    // ONLY exist because steps 1+2 wrote them — a line-number-cached client
    // would have stale offsets here and fail.
    const r3 = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'STEP1',
      end: 'STEP2',
      content: 'STEP3',
    });
    expect(r3.success).toBe(true);
    expect(mockFileContent).toBe('header\nSTEP3\nfooter');

    // Step 4: replace STEP3 with a multi-line block. STEP3 anchor only exists
    // because step 3 just wrote it.
    const r4 = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'STEP3',
      end: 'STEP3',
      content: 'STEP4-LINE-A\nSTEP4-LINE-B\nSTEP4-LINE-C',
    });
    expect(r4.success).toBe(true);
    expect(mockFileContent).toBe(
      'header\nSTEP4-LINE-A\nSTEP4-LINE-B\nSTEP4-LINE-C\nfooter'
    );

    // Step 5: use a multi-line anchor pulled from the step-4 output. The
    // anchor [STEP4-LINE-A\nSTEP4-LINE-B] only resolves uniquely because
    // step 4 wrote those two lines adjacent to each other.
    const r5 = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'STEP4-LINE-A\nSTEP4-LINE-B',
      end: 'STEP4-LINE-C',
      content: 'STEP5-COLLAPSED',
    });
    expect(r5.success).toBe(true);
    expect(mockFileContent).toBe('header\nSTEP5-COLLAPSED\nfooter');

    // Vault.modify should have been called exactly once per successful step.
    expect(app.vault.modify).toHaveBeenCalledTimes(5);
  });

  // ---------------------------------------------------------------------------
  // §8.16 — identical start === end matches exactly once (explicit single-line)
  //   §8.2 already covers the simple case; this one verifies the tool does NOT
  //   double-count a single match when start and end are textually identical.
  // ---------------------------------------------------------------------------
  it('§8.16: identical start === end on a unique line replaces exactly that line', async () => {
    mockFileContent = 'preamble\nUNIQUE-LINE\npostscript';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'UNIQUE-LINE',
      end: 'UNIQUE-LINE',
      content: 'REPLACED-UNIQUE',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('preamble\nREPLACED-UNIQUE\npostscript');
    // single line replaced by single line — totalLines unchanged.
    expect(result.linesDelta).toBe(0);
    expect(result.totalLines).toBe(3);
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'preamble\nREPLACED-UNIQUE\npostscript');
  });

  // ---------------------------------------------------------------------------
  // §8.17 — multi-line start that partially overlaps an end-block region
  //   The plan: "start is multi-line and matches a partial-overlap region (start
  //   block ends mid-way through a candidate `end` block) — tool resolves
  //   correctly — `end` search is over the full file, not bounded by start."
  //   We construct a file where the start block extends into a region that
  //   looks like the end block's prefix, but the actual unique end block lives
  //   later in the file. The end search must find the LATER unique match,
  //   not be confused by overlap.
  // ---------------------------------------------------------------------------
  it('§8.17: multi-line start whose tail overlaps a non-anchor region — end still resolves globally', async () => {
    mockFileContent = [
      'intro',
      '## Section',           // line 2 — start block opens here
      'first body line',      // line 3 — start block continues
      'middle filler',        // line 4
      '## Section',           // line 5 — NOT the start (different content follows)
      'different body',       // line 6
      'END-MARKER',           // line 7 — the unique end anchor
      'trailing',
    ].join('\n');

    // The start block is the two lines [## Section, first body line] — unique.
    // The end anchor is the single unique line "END-MARKER".
    // A naive implementation that searches end ONLY after start would still
    // find END-MARKER, but the contract is that end-search is global; if
    // END-MARKER appeared earlier, we'd flag it via order-error or multi-match.
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: '## Section\nfirst body line',
      end: 'END-MARKER',
      content: 'REWRITTEN',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('intro\nREWRITTEN\ntrailing');
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'intro\nREWRITTEN\ntrailing');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: non-adjacent ambiguous start anchor
  //   The existing §8.5 test has matches at lines 1 and 3 (adjacent). This
  //   exercises a less convenient spread to confirm the line-list is
  //   produced from the actual match positions, not assumed sequence.
  // ---------------------------------------------------------------------------
  it('adversarial: start anchor matching non-adjacent lines reports each line number', async () => {
    mockFileContent = 'TAG\nlineB\nlineC\nlineD\nlineE\nTAG\nlineG\nlineH\nTAG';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'TAG',
      end: 'lineH',
      content: 'x',
    });

    expect(result.success).toBe(false);
    // M3 — plan §6 verbatim ambiguity message with non-adjacent line numbers
    // [1, 6, 9]. Confirms the line-list format survives non-contiguous matches.
    expect(result.error).toBe(
      'start anchor matches 3 locations: lines [1, 6, 9]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.'
    );
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Adversarial: NFKC drift on BOTH anchors simultaneously
  //   The existing §8.10 test drifts only one anchor (start === end). Confirm
  //   tolerance when start and end carry independent compatibility-form drift.
  // ---------------------------------------------------------------------------
  it('adversarial: NFKC drift tolerated on both start and end simultaneously', async () => {
    // File uses compatibility forms on both anchor lines (ordinals + ellipsis +
    // NBSP). NFKC compatibility decomposition canonicalizes ordinals (º→o, ª→a),
    // ellipsis (…→...), and NBSP (U+00A0 → U+0020), so anchors authored in
    // ASCII form must still match. NOTE: canonical accents like á are NOT
    // touched by NFKC — they remain á — so we keep them in the anchor.
    mockFileContent = 'preamble\n1ª linha do bloco\nmiddle content\n2º parágrafo … ok\nfooter';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: '1a linha do bloco',           // ª → a
      end: '2o parágrafo ... ok',           // º → o, NBSP → space, … → ...
      content: 'REWRITTEN',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('preamble\nREWRITTEN\nfooter');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: anchors at file edges (first line and last line)
  // ---------------------------------------------------------------------------
  it('adversarial: replacing from first line through last line rewrites whole file', async () => {
    mockFileContent = 'first-line\nmiddle1\nmiddle2\nlast-line';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'first-line',
      end: 'last-line',
      content: 'WHOLE-FILE-REPLACEMENT',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('WHOLE-FILE-REPLACEMENT');
    expect(result.totalLines).toBe(1);
  });

  it('adversarial: anchor matches the last line of the file', async () => {
    mockFileContent = 'alpha\nbeta\nfinal-line';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'beta',
      end: 'final-line',
      content: 'REPLACED',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('alpha\nREPLACED');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: CRLF input is normalized to LF before anchor comparison
  // ---------------------------------------------------------------------------
  it('adversarial: CRLF line endings in the file are normalized before anchor matching', async () => {
    mockFileContent = 'alpha\r\nbeta\r\ngamma\r\ndelta';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'beta',
      end: 'gamma',
      content: 'CRLF-SAFE',
    });

    expect(result.success).toBe(true);
    // After normalizeCRLF, output should be LF-only.
    expect(mockFileContent).toBe('alpha\nCRLF-SAFE\ndelta');
    expect(mockFileContent).not.toContain('\r');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: multi-line end anchor (mirror of §8.8 for symmetry)
  // ---------------------------------------------------------------------------
  it('adversarial: multi-line end anchor block resolves correctly', async () => {
    mockFileContent = 'head\nbody-1\nbody-2\n## Footer\nLast updated: today\ntrailing';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'body-1',
      end: '## Footer\nLast updated: today',
      content: 'REWRITTEN',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('head\nREWRITTEN\ntrailing');
  });

  // ---------------------------------------------------------------------------
  // Adversarial: empty content with start === end deletes a single line
  //   Coverage cross of §8.2 (single-line) and §8.9 (delete).
  // ---------------------------------------------------------------------------
  it('adversarial: empty content with start === end deletes that single line', async () => {
    mockFileContent = 'keep1\ndelete-me\nkeep2';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'delete-me',
      end: 'delete-me',
      content: '',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('keep1\nkeep2');
    expect(result.linesDelta).toBe(-1);
    expect(result.totalLines).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Adversarial: anchors that bound the entire file deleted
  // ---------------------------------------------------------------------------
  it('adversarial: deleting from first to last line leaves an empty file', async () => {
    mockFileContent = 'one\ntwo\nthree';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'one',
      end: 'three',
      content: '',
    });

    expect(result.success).toBe(true);
    expect(mockFileContent).toBe('');
    expect(result.totalLines).toBe(1); // ''.split('\n').length === 1
    expect(result.linesDelta).toBe(-2);
  });

  // ---------------------------------------------------------------------------
  // Adversarial: leading-slash path is normalized
  //   replace.ts strips a leading '/' before resolving the path; confirm this
  //   doesn't accidentally produce a "File not found" when callers send
  //   absolute-style paths.
  // ---------------------------------------------------------------------------
  it('adversarial: leading-slash path is normalized and resolves to the file', async () => {
    mockFileContent = 'alpha\nbeta\ngamma';
    const result = await tool.execute({
      ...baseParams,
      path: '/test/note.md',
      start: 'beta',
      end: 'beta',
      content: 'B',
    });

    expect(result.success).toBe(true);
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('test/note.md');
    expect(mockFileContent).toBe('alpha\nB\ngamma');
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nB\ngamma');
  });

  // ---------------------------------------------------------------------------
  // Result-shape contract: success path returns diff + totalLines + linesDelta
  // ---------------------------------------------------------------------------
  it('result shape: success returns unified diff, totalLines, and linesDelta', async () => {
    mockFileContent = 'a\nb\nc';
    const result = await tool.execute({
      ...baseParams,
      path: 'test/note.md',
      start: 'b',
      end: 'b',
      content: 'X\nY',
    });

    expect(result.success).toBe(true);
    expect(typeof result.diff).toBe('string');
    expect(result.diff).toContain('@@');
    expect(result.totalLines).toBe(4);
    expect(result.linesDelta).toBe(1);
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledWith(mockFile, 'a\nX\nY\nc');
  });
});
