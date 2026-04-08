# Upstream Merge Plan — Post-v5.6.10

**Target:** `upstream/main` HEAD (`35bed848`)  
**Baseline:** `5.6.10` tag (`425a568f`)  
**Our branch:** `my-custom-branch` (`bc69732f` after congruence cleanup)  
**Created:** 2026-04-07

---

## Upstream PRs to merge (since v5.6.10)

| PR | Title | Our impact |
|----|-------|-----------|
| #103 | fix-mobile-chat | ProviderHttpClient (overlaps our fix) |
| #106 | audit-midway-prs + remove dead per-turn fetches | SystemPromptBuilder cleanup |
| #107 | fix/workspace-context-guard | WorkspaceService guard removal |
| (no PR) | plugin-scoped storage + mobile sync | HybridStorageAdapter overhaul |
| #112 | model-agent-manager-refactor | ModelAgentManager split (5 new files) |
| #113 | sqlite-cache-manager-refactor | SQLiteCacheManager split (6 new files) |
| #114 | build-fixes-system-prompt-model-selection | WorkflowRunService, settings fixes |
| **#115** | **message-bubble-refactor** | **CRITICAL — Tier 1 file** |
| (post-PR) | two-stage migration, cache.db path routing | HybridStorageAdapter init |

---

## Pre-merge setup

```bash
git fetch upstream
git checkout my-custom-branch

# Confirm clean state
git diff --name-only 5.6.10..my-custom-branch   # should match fork_divergence.md exactly
```

Reset `connectorContent.ts` BEFORE merge (already done in bc69732f but do it again post-merge):
```bash
git checkout upstream/main -- src/utils/connectorContent.ts
```

---

## File-by-file resolution guide

### TIER 1 — Manual surgery required

---

#### `src/ui/chat/components/MessageBubble.ts` ⚠️ CRITICAL

**What upstream did (PR #115):** Reduced from 877 → 527 lines by extracting 4 helper classes:
- `helpers/MessageBubbleBranchNavigatorBinder.ts` (new)
- `helpers/MessageBubbleImageRenderer.ts` (new)
- `helpers/MessageBubbleToolEventCoordinator.ts` (new)
- `helpers/MessageBubbleStateResolver.ts` (new)

Constructor now initializes `branchNavigatorBinder`, `imageRenderer`, `toolEventCoordinator`
instead of holding them inline. `MessageBranchNavigator` import removed from `MessageBubble.ts`
(moved into `MessageBubbleBranchNavigatorBinder`).

**Our additions to layer back:**
1. `import { MessageActionBar } from './MessageActionBar';`
2. `private actionBar: MessageActionBar | null = null;` field
3. `appendActionBar()` method (currently at line ~814 in our branch)
4. `cleanupActionBar()` method
5. Call sites: action bar init on mount, cleanup on destroy

**Resolution steps:**
1. `git checkout upstream/main -- src/ui/chat/components/MessageBubble.ts`
2. Accept all 4 new helper files: `git checkout upstream/main -- src/ui/chat/components/helpers/`
3. Open `MessageBubble.ts` and add back the 5 action bar items above
4. Verify the constructor, mount, and destroy hooks are the correct insertion points
5. Build and test that the action bar still renders and cleans up

**Risk:** Medium. Upstream changed the class structure significantly but our additions are
self-contained. The `appendActionBar()` call site currently triggers after `createElement()` —
verify that hook still exists in the refactored version.

---

#### `src/ui/chat/components/factories/ToolBubbleFactory.ts`

**What upstream did:** Likely whitespace-only (not in upstream diff since 5.6.10). Auto-merge.

**Our addition:** 3-param `createTextBubble` (removed `onCopy`/`showCopyFeedback`).

**Resolution:** Likely clean auto-merge. If conflict, take upstream base + restore 3-param signature.

---

### TIER 2 — Accept upstream, drop/reconsider our version

---

#### `src/services/llm/adapters/shared/ProviderHttpClient.ts`

**What upstream did (PR #103):** Ships a BETTER version of our fix:
- Uses `desktopRequire<typeof import('node:https')>('node:https')` instead of our raw `require()`
- Also adds `isDesktop()` guard before `hasNodeRuntime()`
- Replaces `new Readable(...)` (requires `node:stream`) with a plain `AsyncIterable<string>`
  — completely eliminates Node.js stream dependency in the mobile fallback path

**Action: Take upstream's version entirely. Drop our fork's ProviderHttpClient changes.**

The upstream version is architecturally better (uses `desktopRequire` consistently, avoids
`node:stream` entirely). Our `resRef?.destroy(err)` timeout fix should be checked — see if
upstream kept or dropped that. If they dropped it, we may want to keep it as a Tier 3 fork fix.

```bash
git checkout upstream/main -- src/services/llm/adapters/shared/ProviderHttpClient.ts
```

Then check if `resRef?.destroy(err)` (our timeout improvement) is present. If not, add it back.

---

#### `src/database/repositories/ConversationRepository.ts`

**What upstream did:** Ships a tombstone approach for conversation deletion:
- Writes a `ConversationDeletedEvent` to JSONL BEFORE deleting from SQLite
- This ensures reconciliation can detect the deletion even if SQLite is rebuilt from JSONL
- Does NOT delete the JSONL file

**Our approach:** Deleted the JSONL file entirely (simpler, removes orphan files).

**Action: Take upstream's tombstone approach. Drop our JSONL-file-delete from `delete()`.**

Upstream's approach is safer for mobile sync (JSONL is source of truth; deleting it breaks
rebuild). Our approach was a symptom-fix for the orphan file problem — the tombstone is the
correct architectural solution.

Also: upstream has `ConversationDeletedEvent` — ensure `StorageEvents.ts` is taken from upstream
(it will be in the auto-merge since upstream added this event type).

```bash
git checkout upstream/main -- src/database/repositories/ConversationRepository.ts
# Verify no action-bar-related code is in this file (there isn't any)
```

---

#### `src/database/repositories/MessageRepository.ts`

**What upstream did:** Likely no functional change (not in upstream diff list).

**Our addition:** Skip JSONL writes during streaming states (`draft`/`streaming`).

**Action:** Likely clean auto-merge. Keep our streaming optimization.

---

### TIER 3 — Significant upstream refactors with fork additions to preserve

---

#### `src/database/storage/SQLiteCacheManager.ts` + new split files (PR #113)

**What upstream did:** Split into 6 files:
- `SQLiteMaintenanceService.ts` (new)
- `SQLitePersistenceService.ts` (new)
- `SQLiteSyncStateStore.ts` (new)
- `SQLiteTransactionCoordinator.ts` (new)
- `SQLiteWasmBridge.ts` (new)
- `SQLiteCacheManager.ts` (kept as facade/orchestrator, now smaller)

**Our addition:** `fixVec0TableDimensions()` — drops/recreates `note_embeddings` and
`block_embeddings` vec0 tables if they were built with `float[768]` (legacy Nomic era).
Runs once after migrations during `initialize()`.

**Action:** Take all 6 new upstream files. Then find where `initialize()` lives after the split
(probably `SQLiteCacheManager.ts` or `SQLiteMaintenanceService.ts`) and add the
`fixVec0TableDimensions()` call back in the correct post-migration position.

**Note:** This fix is fork-specific (our installation had a bad vec0 dimension from the abandoned
Nomic embedding experiment). It is harmless if dimensions are already correct (no-op path).

```bash
# Accept all new files
git checkout upstream/main -- src/database/storage/SQLiteCacheManager.ts
git checkout upstream/main -- src/database/storage/SQLiteMaintenanceService.ts
git checkout upstream/main -- src/database/storage/SQLitePersistenceService.ts
git checkout upstream/main -- src/database/storage/SQLiteSyncStateStore.ts
git checkout upstream/main -- src/database/storage/SQLiteTransactionCoordinator.ts
git checkout upstream/main -- src/database/storage/SQLiteWasmBridge.ts
# Then re-add fixVec0TableDimensions() to the correct location
```

---

#### `src/database/adapters/HybridStorageAdapter.ts`

**What upstream did:** Major changes:
- Plugin-scoped storage path routing (uses `PluginStoragePathResolver`)
- Two-stage migration logic with new `cache.db` path detection
- `await storage adapter ready before embedding init` fix
- Step numbering updated (5→6, 6→7 for existing steps) — upstream added their own step 5

**Our addition:** `pruneOrphanedConversationFiles()` — step 5 in our version, runs on startup
to clean JSONL files for conversations not in SQLite.

**Action:** Take upstream as base. Preserve our `pruneOrphanedConversationFiles()` method.

However, given that upstream now uses tombstone deletion (ConversationDeletedEvent), the orphan
file problem is resolved going forward. Consider whether the startup pruning is still needed:
- **Yes, keep it:** Still useful for one-time cleanup of pre-tombstone orphans that exist in
  our current `.nexus/conversations/` directory from before this fix
- Renumber our step to fit after upstream's new steps

```bash
git checkout upstream/main -- src/database/adapters/HybridStorageAdapter.ts
# Add back pruneOrphanedConversationFiles() and its startup call
```

---

#### `src/database/storage/JSONLWriter.ts`

**What upstream did:** Added tests (`tests/unit/JSONLWriter.test.ts`). The implementation file
itself may have minor changes.

**Our addition:** `readEventsStreaming()` — readline fallback for files >50 MB. Also `listFiles()`
and `deleteFile()` methods (added to support our pruning feature).

**Note on `deleteFile()`:** Since upstream uses tombstone approach, `deleteFile()` is no longer
called from `ConversationRepository.delete()`. It is still called from
`pruneOrphanedConversationFiles()`. Keep it.

**Action:** Check if upstream's `JSONLWriter.ts` changed. If so, take upstream base + layer back
our 3 added methods. If not, auto-merge.

---

### TIER 4 — Pure upstream acceptance (no fork additions here)

These files have upstream changes and no fork-specific content. **Take upstream entirely:**

| File | Upstream change |
|------|----------------|
| `src/ui/chat/services/ModelAgentManager.ts` | Facade over new split services |
| `src/ui/chat/services/ModelAgentCompactionState.ts` | New (PR #112 split) |
| `src/ui/chat/services/ModelAgentConversationSettingsStore.ts` | New (PR #112 split) |
| `src/ui/chat/services/ModelAgentDefaultsResolver.ts` | New (PR #112 split) |
| `src/ui/chat/services/ModelAgentPromptContextAssembler.ts` | New (PR #112 split) |
| `src/ui/chat/services/ModelAgentWorkspaceContextService.ts` | New (PR #112 split) |
| `src/database/migration/PluginScopedStorageCoordinator.ts` | New |
| `src/database/storage/PluginStoragePathResolver.ts` | New |
| `src/utils/pluginDataLock.ts` | New |
| `src/ui/chat/services/SystemPromptBuilder.ts` | Remove dead per-turn fetches (PR #106) |
| `src/core/PluginLifecycleManager.ts` | Updated for new service split |
| `src/core/commands/MaintenanceCommandManager.ts` | Minor updates |
| `src/core/services/ServiceDefinitions.ts` | New service registrations |
| `src/database/sync/ConversationEventApplier.ts` | Tombstone delete handling |
| `src/database/interfaces/StorageEvents.ts` | `ConversationDeletedEvent` added |
| `src/services/workflows/WorkflowRunService.ts` | Type error fixes (PR #114) |
| `src/settings.ts` | Updated for new services |
| `src/types/plugin/PluginTypes.ts` | New type definitions |
| `src/types/sqlite3-vec-wasm.d.ts` | New WASM type declarations |

---

## Downstream impact: our fork fixes to reconsider

### `eslint.config.mjs`
We added `JSONLWriter.ts` to `import/no-nodejs-modules` exceptions because our streaming code
uses `require('fs')` and `require('readline')`. After the merge, if upstream's `JSONLWriter.ts`
retains our streaming methods, keep the exception. Otherwise remove it.

### `src/settings/tabs/ProvidersTab.ts` and `src/components/LLMProviderModal.ts`
Our changes simplified the `onSave` handler. Check if upstream's PR #114 touched these files.
If upstream modified them, reconcile carefully — our changes were a real improvement.

### `src/components/shared/ChatSettingsRenderer.ts`
Minor `void` removal. Likely no conflict with upstream.

---

## Merge execution sequence

Execute in this order to minimize conflict cascades:

```
1. git fetch upstream

2. Accept all Tier 4 pure-upstream files first (git checkout upstream/main -- <file>)

3. Accept new split files (ModelAgentManager helpers, SQLiteCacheManager split, helpers/)

4. Merge conflict files one by one in this order:
   a. ProviderHttpClient.ts   (take upstream, check timeout fix)
   b. ConversationRepository.ts (take upstream's tombstone approach)
   c. HybridStorageAdapter.ts  (take upstream, add back pruneOrphanedConversationFiles)
   d. SQLiteCacheManager.ts    (take upstream, re-add fixVec0TableDimensions)
   e. JSONLWriter.ts           (merge, keep readEventsStreaming + listFiles + deleteFile)
   f. MessageBubble.ts         (take upstream, layer back action bar additions)

5. Verify fork-only files untouched:
   - MessageActionBar.ts  (should be unmodified by merge)
   - CreateFileModal.ts   (should be unmodified by merge)

6. Post-merge checks:
   - git diff upstream/main..my-custom-branch --name-status
   - Verify only expected fork divergences remain (compare to fork_divergence.md)
   - npm run build
   - npm run test
   - Manual test: action bar renders, copy works, context progress bar updates
   - Reset connectorContent.ts: git checkout upstream/main -- src/utils/connectorContent.ts

7. Tag and deploy:
   - git tag merge/upstream-post-5.6.10 (or whatever upstream tags the new version)
   - npm run deploy
```

---

## Key decision: pruneOrphanedConversationFiles()

Upstream explicitly rejected this feature (PR audit: "inverts JSONL-as-source-of-truth
architecture"). Their concern is valid for forward-looking deletions. However:

- Our vault already HAS orphaned files from the pre-tombstone era
- Running the pruner once cleans them up safely (SQLite is accurate at this point)
- After the tombstone fix lands, no new orphans will be created

**Recommendation:** Keep `pruneOrphanedConversationFiles()` as a fork-only startup cleanup.
Once we've confirmed no orphans remain (a few weeks of use), we can remove it. Add a log
message counting existing orphans vs. pruned count on each startup to track progress to zero.

---

## Notes on upstream's PR audit of our work

The upstream team (`docs/review/midway65-pr-audit-2026-04-07.md`) reviewed our PRs #104/#105
and reached these conclusions (relevant to this merge):

- **Schema v12–v19:** Rejected (fork-specific). Our `fixVec0TableDimensions()` stays fork-only.
- **Action bar:** Rejected (UI noise). Stays fork-only.
- **Orphaned JSONL pruning:** Rejected (architectural concern). We keep it as a one-time cleanup fork addition with the reasoning above.
- **ProviderHttpClient fix:** Accepted separately — they shipped a better version. Take theirs.
- **Workspace optimization (G-W1–W4):** Approved — but these are the commits we REVERTED. They were merged upstream as PR #106/107 separately. Do not re-add them from our reverted commits — just take upstream.
