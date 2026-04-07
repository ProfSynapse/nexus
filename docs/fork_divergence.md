# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Last audited against:** v5.6.10 (`425a568f`)  
**Audit date:** 2026-04-07

---

## Tier 1 — Always conflict on upstream merge

These files contain fork-specific additions that upstream will never have. Every upstream merge
requires manual resolution using the pattern: accept upstream base, then layer back the fork additions.

| File | Fork change | Resolution pattern |
|------|-------------|-------------------|
| `src/ui/chat/components/MessageBubble.ts` | Action bar: `import MessageActionBar`, `private actionBar` field, `appendActionBar()`, `cleanupActionBar()`, call sites at mount/cleanup | Take upstream as base; layer back all action bar lines |
| `src/ui/chat/components/factories/ToolBubbleFactory.ts` | `createTextBubble` is 3-param (onCopy/showCopyFeedback removed — action bar owns copy) | Take upstream; restore 3-param signature |

**Fork-only files (no upstream counterpart — always rebase cleanly):**
- `src/ui/chat/components/MessageActionBar.ts`
- `src/ui/chat/components/CreateFileModal.ts`

---

## Tier 2 — Conflict only when upstream touches them

These files have fork additions that are self-contained. Upstream rarely touches them, but when
they do a conflict will occur. Resolution is always: take upstream base, then restore the fork block.

| File | Fork change | Fork block to restore |
|------|-------------|----------------------|
| `styles.css` | Sticky assistant header rule | CSS rule block labelled `/* fork: sticky assistant header */` |
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Banner removal (beta/experimental warning stripped) | Remove the banner call after taking upstream |
| `src/database/schema/SchemaMigrator.ts` | Convention comment + fork migrations v12–v19 | Comment block + all migrations numbered ≥ 20 (our convention: upstream ≤ 19, fork ≥ 20) |

---

## Tier 3 — Fork bug fixes (low conflict risk, but track for awareness)

These files contain fixes for bugs present in upstream or data-quality issues specific to this
installation. They are unlikely to conflict because upstream is not touching the same lines, but
they must be reviewed on each merge to ensure upstream hasn't shipped a conflicting fix.

### Null-safe `workspace.name` fixes
Upstream has a historical record with `name: null` that crashes `.toLowerCase()`. Fixed with
optional chaining. If upstream fixes this themselves, take their version and drop ours.

| File | Change |
|------|--------|
| `src/agents/searchManager/services/MemorySearchProcessor.ts` | `state.name?.toLowerCase()`, `workspace.name?.toLowerCase()` |
| `src/agents/toolManager/services/ToolBatchExecutionService.ts` | `workspace.name?.toLowerCase()` |
| `src/services/WorkspaceService.ts` | `(a.name ?? '').localeCompare(b.name ?? '')`, two `ws.name?.toLowerCase()` guards |

### JSONL data quality fixes
Fixes for orphaned JSONL files left by the pre-fix `deleteConversation` bug, streaming write
amplification, and large-file read limits.

| File | Change |
|------|--------|
| `src/database/adapters/HybridStorageAdapter.ts` | `pruneOrphanedConversationFiles()` runs on startup to clean orphaned `.jsonl` files |
| `src/database/repositories/ConversationRepository.ts` | `delete()` now deletes the JSONL file in addition to the SQLite row |
| `src/database/repositories/MessageRepository.ts` | Skips JSONL write during streaming states (`draft`/`streaming`) — prevents O(n²) storage growth |
| `src/database/storage/JSONLWriter.ts` | `readEventsStreaming()` fallback via Node.js readline for files >50 MB |
| `eslint.config.mjs` | Added `JSONLWriter.ts` to `import/no-nodejs-modules` exceptions (uses `require('fs')`, `require('readline')`) |

### Schema / embedding fix

| File | Change |
|------|--------|
| `src/database/storage/SQLiteCacheManager.ts` | `fixVec0TableDimensions()` — drops and recreates `note_embeddings` / `block_embeddings` if they were created with `float[768]` (legacy Nomic era); runs once after migrations on init |

### Provider / HTTP fixes

| File | Change |
|------|--------|
| `src/services/llm/adapters/shared/ProviderHttpClient.ts` | Uses `require('https')`/`require('http')` instead of dynamic `import()` (Electron renderer CORS blocks `node:` protocol); timeout handler destroys both `req` and `res` to prevent silent stream truncation |
| `src/settings/tabs/ProvidersTab.ts` | `onSave` simplified from IIFE `void (async () => {...})()` to direct `async` callback |
| `src/components/LLMProviderModal.ts` | `onSave` type widened to `void \| Promise<void>`; auto-save path awaits the callback with try/catch |

### UI / UX fixes

| File | Change |
|------|--------|
| `src/ui/chat/ChatView.ts` | Registers `active-leaf-change` to refresh context progress bar when view regains focus |
| `src/ui/chat/components/ContextProgressBar.ts` | Uses `removeAttribute('class') + addClass()` instead of `className =` (Obsidian API correctness) |
| `src/ui/chat/components/BranchHeader.ts` | JSDoc updated — documents skip-re-render guard against `registerDomEvent` accumulation |
| `src/components/shared/ChatSettingsRenderer.ts` | Removed `void` from `this.syncWorkspacePrompt(value)` call |

---

## Special case — connectorContent.ts

`src/utils/connectorContent.ts` is generated during build (timestamp in header). It should be
**reset to upstream before every merge** with:

```
git checkout <upstream-tag> -- src/utils/connectorContent.ts
```

Do not treat timestamp-only diffs as fork divergences.

---

## How to use this file

1. Before each upstream merge, run: `git diff --name-status <tag>..my-custom-branch`
2. Cross-reference each modified file against this registry
3. Files not listed here should match upstream exactly — investigate any that don't
4. After resolving conflicts, re-run the diff to confirm no unintended divergences remain
5. If new fork additions are made, add them to this file before committing
