# Fork Divergence Registry

This file is the authoritative record of every file in `my-custom-branch` that intentionally
diverges from upstream (`ProfSynapse/nexus`). Load it at the start of every upstream merge
session to know which files require manual resolution and which can be auto-merged.

**Last audited against:** upstream/main HEAD (`f4e49fd3`) — PRs #118, #119, #121  
**Audit date:** 2026-04-08  
**Next merge target:** next upstream/main HEAD (watch for new PRs)

---

## Tier 1 — Always conflict on upstream merge

These files contain fork-specific additions that upstream will never have. Every upstream merge
requires manual resolution using the pattern: accept upstream base, then layer back the fork additions.

| File | Fork change | Resolution pattern |
|------|-------------|-------------------|
| `src/ui/chat/components/MessageBubble.ts` | Action bar: `import MessageActionBar`, `private actionBar` field, `appendActionBar()`, `cleanupActionBar()`, call sites in createElement/updateWithNewMessage/cleanup | Take upstream as base; layer back all action bar insertions; fix `createTextBubble` call back to 3-arg (upstream keeps reverting to 7-arg) |
| `src/ui/chat/components/factories/ToolBubbleFactory.ts` | `createTextBubble` is 3-param (onCopy/showCopyFeedback removed — action bar owns copy). **Note:** upstream base is 7-param but upstream has not changed this file — git auto-keeps our 3-param. The recurring risk is the **call site in MessageBubble.ts** — every merge where upstream touches MessageBubble risks reverting it to 7 args. Always check after merge and fix if needed. | Git auto-keeps 3-param; verify MessageBubble.ts call site is 3-arg |

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
| `src/database/adapters/HybridStorageAdapter.ts` | `pruneOrphanedConversationFiles()` runs on startup — **TEMPORARY**; remove once vault reports zero pruned files for several consecutive sessions. Also upstream touched this file in PR #119 and likely will again. | Re-insert `if (syncState) { await pruneOrphanedConversationFiles() }` block after `getSyncState` call, before rebuild/sync. Keep upstream's `initialized = true` block ABOVE it. |

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
Fixes for streaming write amplification and large-file read limits. ConversationRepository now
uses upstream's tombstone approach (no fork divergence); pruning still needed for pre-tombstone orphans.

| File | Change |
|------|--------|
| `src/database/adapters/HybridStorageAdapter.ts` | `pruneOrphanedConversationFiles()` runs on startup to clean orphaned `.jsonl` files — **temporary**: remove once vault reports zero pruned files at startup for several consecutive sessions |
| `src/database/repositories/MessageRepository.ts` | Skips JSONL write during streaming states (`draft`/`streaming`) — prevents O(n²) storage growth |
| `src/database/storage/JSONLWriter.ts` | `readEventsStreaming()` fallback via Node.js readline for files >50 MB; `stat?.()` optional-chain safe for test environments |
| `eslint.config.mjs` | Added `JSONLWriter.ts` to `import/no-nodejs-modules` exceptions (uses `require('fs')`, `require('readline')`) |

### Schema / embedding fix

| File | Change |
|------|--------|
| `src/database/storage/SQLiteMaintenanceService.ts` | `fixVec0TableDimensions()` — drops and recreates `note_embeddings` / `block_embeddings` if they were created with `float[768]` (legacy Nomic era); no-op when dimensions correct |
| `src/database/storage/SQLiteCacheManager.ts` | Calls `getMaintenanceService().fixVec0TableDimensions()` after migrations in `initialize()` |

### Provider / HTTP fixes

| File | Change |
|------|--------|
| `src/settings/tabs/ProvidersTab.ts` | `onSave` simplified from IIFE `void (async () => {...})()` to direct `async` callback |
| `src/components/LLMProviderModal.ts` | `onSave` type widened to `void \| Promise<void>`; auto-save path awaits the callback with try/catch |

### UI / UX fixes

| File | Change |
|------|--------|
| `src/ui/chat/components/ContextProgressBar.ts` | Uses `removeAttribute('class') + addClass()` instead of `className =` (Obsidian API correctness) |
| `src/components/shared/ChatSettingsRenderer.ts` | Removed `void` from `this.syncWorkspacePrompt(value)` call |

**Retired entries (absorbed by upstream PR #119):**
- `ChatView.ts` — `active-leaf-change` handler: now in upstream's ChatView (line 607). No longer fork-divergent.
- `BranchHeader.ts` — JSDoc: BranchHeader ownership moved to `ChatBranchViewCoordinator`. No longer fork-divergent.

---

## Special case — connectorContent.ts

`src/utils/connectorContent.ts` is generated during build (timestamp in header). It should be
**reset to upstream before every merge** with:

```
git checkout upstream/main -- src/utils/connectorContent.ts
```

Do not treat timestamp-only diffs as fork divergences.

---

## How to use this file

1. Before each upstream merge, run: `git diff --name-status upstream/main..my-custom-branch`
2. Cross-reference each modified file against this registry
3. Files not listed here should match upstream exactly — investigate any that don't
4. After resolving conflicts, re-run the diff to confirm no unintended divergences remain
5. If new fork additions are made, add them to this file before committing
