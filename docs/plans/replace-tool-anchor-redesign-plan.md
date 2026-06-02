# Pattern-Anchored `content replace` Tool — Design Spec

**Status**: Design locked, ready for implementation
**Author**: Spec'd in conversation 2026-05-09 / 11
**Risk**: Medium — breaking schema change to a load-bearing tool. No backwards-compat shim. Ships in next minor.
**Files affected**:
- `src/agents/contentManager/types.ts` (interface rewrite)
- `src/agents/contentManager/tools/replace.ts` (execute + schema rewrite)
- `src/agents/promptManager/...` (`executePrompts.replace` action — companion migration)
- `tests/agents/contentManager/replace.test.ts` (full rewrite)
- `docs/changelog.md` (entry)
- Pinned context in CLAUDE.md (PR #170 pin retire / replace)

---

## 1. Motivation

The current `content replace` tool requires the LLM to pass:
- `path`
- `oldContent` — verbatim text of the full range being replaced
- `newContent`
- `startLine` + `endLine`

For replacements of ~200 lines, `oldContent` costs ~10K tokens just to fingerprint a range. The line numbers also go stale across edits — once one replace runs, every subsequent edit must either re-read or guess the new line numbers.

Goals for the redesign:
- **Single schema, single mode** (no `oneOf`, no "use X for short / Y for long").
- **Minimum tokens** — fingerprint cost independent of range size.
- **Survives sequential edits without re-reading** — anchors are content-based, so prior edits that shift line numbers do not invalidate them.
- **No counting** — LLMs are unreliable at line-counting; no count or line-number arithmetic required.

Inspiration: `sed '/start/,/end/c\ new'` — pattern-based range identification.

---

## 2. Schema

```typescript
export interface ReplaceParams extends CommonParameters {
  /** Path to the file to modify. Do not include a leading slash. */
  path: string;

  /** Verbatim text marking the start of the range. Must match exactly
   *  one location in the file as a contiguous line-block. Included in
   *  the range that gets replaced. */
  start: string;

  /** Verbatim text marking the end of the range. Must match exactly
   *  one location in the file as a contiguous line-block. Included in
   *  the range that gets replaced. */
  end: string;

  /** Replacement text. Set to an empty string to delete the range. */
  content: string;
}
```

Four fields. No `oldContent`, no `newContent`, no `startLine`, no `endLine`, no `lineCount`.

---

## 3. Tool semantics

```
1. Read file, normalize CRLF and apply NFKC for comparison only.
2. Find all offsets where `start` matches as a contiguous line-block.
3. Find all offsets where `end` matches as a contiguous line-block.
4. Apply uniqueness rules:
   - start matches == 0: error (re-read advice)
   - start matches >  1: error (multi-line extension advice, lists line numbers)
   - end matches   == 0: error (re-read advice)
   - end matches   >  1: error (multi-line extension advice, lists line numbers)
5. Let s = unique start match (start line index, end line index of the start block).
   Let e = unique end match (start line index, end line index of the end block).
6. If e.endLineIdx < s.startLineIdx: error (order)
7. Replace fileLines[s.startLineIdx .. e.endLineIdx] (inclusive) with
   `content` split by `\n`. Empty `content` deletes the range entirely.
8. Write modified file via vault.modify.
9. Return { success: true, linesDelta, totalLines, diff }.
```

### Pattern matching is line-block based, NOT substring

`start` and `end` match **whole lines**. `start = "## Header"` matches a line whose entire text (after normalization) is `## Header`. It does NOT match a line like `// ## Header //` or `## Header for X`.

Multi-line anchors: `start` may contain `\n` to match a sequence of contiguous whole lines.

### NFKC + CRLF normalization

Same normalization function as today (`normalizeForCompare` in `replace.ts:44`) is reused. Tolerates Unicode drift (`º` vs `o`, ellipsis, NBSP) and line-ending drift. Normalization is for comparison only; the file is not rewritten in a different form.

---

## 4. CLI form

```
content replace --path note.md \
  --start "## Architecture" \
  --end "</details>" \
  --content "..."
```

For ambiguous anchors, model extends to multi-line:

```
content replace --path note.md \
  --start "## Header\nLast updated: 2026-04-01" \
  --end "</details>\n## Next Section" \
  --content "..."
```

No CLI normalizer changes needed — `start`/`end`/`content`/`path` are plain string flags handled by the existing string-flag path in `ToolCliNormalizer.ts`. Smoke-test verify.

---

## 5. Schema descriptions (steer the model)

These appear in `getParameterSchema()` and are read by the LLM. They are the spec for how the model picks anchors.

```text
path:    Path to the note to modify (e.g. "folder/note.md"). Do not include
         a leading slash.

start:   The opening line(s) of the range you want to replace, copied
         verbatim from your read. Must match exactly one location in the
         file. If a single line is not unique, extend `start` to multiple
         lines using \n until it identifies one location only.

end:     The closing line(s) of the range. Same rules as `start`. Must
         come after `start` in the file.

content: What to write in place of the range from `start` through `end`
         (inclusive of both anchor lines). Set to an empty string to
         delete the range entirely.
```

Tool top-level description:

```text
Replace or delete a range of content in a note, identified by start and
end text anchors. Anchors are matched as whole lines; pass multi-line
text via \n if a single line is not unique. Line numbers are never
required.
```

---

## 6. Error messages

Error messages do real work — they coach the model toward fixing its input on the next call.

| Scenario | Message |
|---|---|
| `start` not found | `start anchor not found in file. The content may have been edited since your last read — re-read the file and try again.` |
| `end` not found | `end anchor not found in file. The content may have been edited since your last read — re-read the file and try again.` |
| `start` matches N times | `start anchor matches N locations: lines [L1, L2, ...]. Make it unique by extending it — include the next line (or several) using \n so it identifies one location only.` |
| `end` matches N times | Same shape, with `end anchor`. |
| `end` appears before `start` | `end anchor is at line E but start anchor is at line S (S > E). Check that start and end are in the right order in the file.` |
| Either anchor empty / whitespace-only | `start and end must contain non-whitespace text. Pick distinctive lines from your read.` |
| File not found | (existing) `File not found: "${path}". Use search content to find files by name, or storageManager.list to explore folders.` |
| Path is a folder | (existing) `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.` |

---

## 7. Implementation pointers

### 7.1 `src/agents/contentManager/types.ts:101-116`

Replace the `ReplaceParams` interface with the new 4-field shape from §2. Delete `oldContent`, `newContent`, `startLine`, `endLine`. The new field is `content`.

`ReplaceResult` (lines 118-130) is unchanged — same `success` / `linesDelta` / `totalLines` / `diff` shape.

### 7.2 `src/agents/contentManager/tools/replace.ts:118-225`

Rewrite `execute`. Drop:
- Line-number validation block (lines 138-165)
- `oldContent` compare path (lines 167-196)
- Splice via line indices (lines 198-217)

New flow:

```typescript
async execute(params: ReplaceParams): Promise<ReplaceResult> {
  try {
    const { path, start, end, content } = params;

    if (!start.trim() || !end.trim()) {
      return this.prepareResult(false, undefined,
        'start and end must contain non-whitespace text. Pick distinctive lines from your read.');
    }

    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) return this.prepareResult(false, undefined,
      `File not found: "${path}". Use search content to find files by name, or storageManager.list to explore folders.`);
    if (!(file instanceof TFile)) return this.prepareResult(false, undefined,
      `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`);

    const fileText = normalizeCRLF(await this.app.vault.read(file));
    const fileLines = fileText.split('\n');

    const startMatches = findLineBlock(fileLines, start);
    const endMatches   = findLineBlock(fileLines, end);

    if (startMatches.length === 0) return ... ;     // re-read advice
    if (startMatches.length > 1)  return ... ;      // extension advice with line numbers
    if (endMatches.length === 0)  return ... ;
    if (endMatches.length > 1)    return ... ;

    const s = startMatches[0];
    const e = endMatches[0];
    if (e.end < s.start) return ... ;               // order error

    const beforeLines = fileLines.slice(0, s.start);
    const afterLines  = fileLines.slice(e.end + 1);
    const newLinesArr = content === '' ? [] : normalizeCRLF(content).split('\n');

    const resultContent = [...beforeLines, ...newLinesArr, ...afterLines].join('\n');
    await this.app.vault.modify(file, resultContent);

    const finalLines = resultContent.split('\n');
    const delta = finalLines.length - fileLines.length;
    return this.buildResult(fileLines, finalLines, delta);
  } catch (error) {
    return this.prepareResult(false, undefined, createErrorMessage('Error replacing content: ', error));
  }
}
```

### 7.3 New helper: `findLineBlock`

```typescript
/**
 * Find all line-block occurrences of `blockText` in `fileLines`.
 * Returns 0-based [startIdx, endIdx] inclusive offsets for each match.
 * Uses NFKC+CRLF normalization for comparison (same as findContentInLines).
 */
function findLineBlock(
  fileLines: string[],
  blockText: string,
): Array<{ start: number; end: number }> {
  const blockLines = blockText.split('\n');
  const matches: Array<{ start: number; end: number }> = [];
  if (blockLines.length === 0 || blockLines.length > fileLines.length) return matches;

  const normalizedBlock = blockLines.map(normalizeForCompare);
  const normalizedFile  = fileLines.map(normalizeForCompare);

  for (let i = 0; i <= normalizedFile.length - normalizedBlock.length; i++) {
    let found = true;
    for (let j = 0; j < normalizedBlock.length; j++) {
      if (normalizedFile[i + j] !== normalizedBlock[j]) { found = false; break; }
    }
    if (found) matches.push({ start: i, end: i + normalizedBlock.length - 1 });
  }
  return matches;
}
```

Note: `findContentInLines` (the existing helper) becomes dead code after this rewrite. Delete it.

### 7.4 `src/agents/contentManager/tools/replace.ts:227-256`

Rewrite `getParameterSchema` with the new descriptions from §5. `required: ['path', 'start', 'end', 'content']`.

### 7.5 `src/agents/promptManager` — `executePrompts.replace` action

Per the v5.8.2 pin in CLAUDE.md, the `executePrompts` `replace` action mirrors the `content replace` schema (`oldContent` + `startLine` + `endLine`). Migrate to the same `start` / `end` / `content` shape in lockstep. One PR, both surfaces.

Specific files (verify in fresh session):
- The action handler for `replace` inside `BatchExecutePromptTool` (or wherever `executePrompts.replace` is dispatched)
- Validation / normalization logic that mirrors the line-range checks

### 7.6 `src/agents/toolManager/services/ToolCliNormalizer.ts`

No changes expected. Verify on smoke test that:
- `--start "..."` survives CLI parse with newlines (model passes `\n` in quoted strings)
- `--end "..."` same
- `--content "..."` same
- `\uXXXX` decoding still applies (per PR #170 pin)

---

## 8. Test plan (`tests/agents/contentManager/replace.test.ts` — full rewrite)

Delete all existing line-number-based tests.

| # | Scenario | Expected |
|---|---|---|
| 1 | Unique start, unique end, multi-line range | Range replaced inclusive of both anchor lines, correct linesDelta |
| 2 | `start === end` (single-line replace) | That single line replaced |
| 3 | `start` not found | Error: "start anchor not found ... re-read" |
| 4 | `end` not found | Error: "end anchor not found ... re-read" |
| 5 | `start` matches twice | Error listing both line numbers, advising multi-line extension |
| 6 | `end` matches twice (anywhere in file, including before start) | Error listing both, same advice |
| 7 | `start` at line 200, `end` at line 50 (both unique) | Order error referencing both line numbers |
| 8 | Multi-line `start` (two lines joined with `\n`, unique as a block) | Resolves correctly |
| 9 | `content === ""` (delete) | Range deleted, `linesDelta` negative |
| 10 | NFKC drift on start (`º` vs `o`, or ellipsis vs `...`) | Tolerated; match succeeds |
| 11 | Empty `start` | Validation error |
| 12 | Whitespace-only `end` | Validation error |
| 13 | File not found | Existing error path |
| 14 | Path is a folder | Existing error path |
| 15 | Sequential edits in one batch (replace A, then replace B in same file) | Both succeed; second call uses content-based anchors against post-first-edit file state |
| 16 | `start` and `end` are the same anchor and match exactly once | Single-line replacement (same as #2) |
| 17 | `start` is multi-line and matches a partial-overlap region (start block ends mid-way through a candidate `end` block) | Tool resolves correctly — `end` search is over the full file, not bounded by start's location |

Use the existing test scaffolding (Obsidian app mock, vault.read/modify mocks). No fake-indexeddb needed.

---

## 9. Migration & rollout

- **Hard schema break**. No compat shim. Existing callers passing `oldContent`/`startLine`/`endLine` get a clean validation error.
- **One PR covers both** the agent tool (`ContentManager.replace`) and the `executePrompts.replace` action.
- **Changelog entry** in `docs/changelog.md` for the next minor (likely 5.9.0).
- **CLAUDE.md pin retire**: the PR #170 pin section "ToolManager MCP contract: CLI-first only (as of v5.8.2 / PR #170)" mentions `executePrompts` actions: `replace` uses `oldContent` + `startLine` + `endLine`. Update that pin once this lands.
- **No version-gating** — straight to next minor.

---

## 10. Resolved design decisions

For the record:

1. **No replace-to-end-of-file special case.** Model passes the actual last line of the file as `end`. No `<<EOF>>` sentinel, no `replaceToEnd` flag. Keeps schema minimal.
2. **`end` matching is globally unique**, not "first occurrence after start" (sed-style). Both anchors must be globally unique in the file. Simpler invariant, easier to explain, safer.
3. **`executePrompts.replace` migrates together** with `content replace`. One PR, both surfaces.

---

## 11. Open questions

None. Implementation can proceed.

---

## 12. Notes for the implementor

- Reuse `normalizeCRLF` and `normalizeForCompare` from `replace.ts:25-46`. Do not write new normalization.
- `generateUnifiedDiff` (used in `buildResult`) is unchanged — produces the same `@@ -N,M +N,M @@` format the model uses to derive subsequent edits.
- `getStatusLabel` is unchanged.
- Result shape (`success`, `linesDelta`, `totalLines`, `diff`) is unchanged.
- Strip mentions of `oldContent` / `startLine` / `endLine` from anywhere in the codebase that documents `replace`:
  - `getParameterSchema` description
  - `executePrompts` action docs
  - any inline doc comments in `replace.ts` / `types.ts`
  - the PR #170 CLAUDE.md pin
- The pre-existing `findContentInLines` helper becomes dead code. Delete.
- Existing `replace.test.ts` cases are all line-number-based. Replace the file wholesale.
- Verify in smoke test: model can compose `--start "## Foo\nLast updated:"` via the CLI normalizer. The `\n` should land as a real newline in `params.start`.

End of spec.
