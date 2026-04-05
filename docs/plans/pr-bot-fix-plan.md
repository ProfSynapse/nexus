# Fix Plan — obsidian-releases Bot Violations (PR #11597)

**PR**: https://github.com/obsidianmd/obsidian-releases/pull/11597
**Generated**: 2026-04-01
**Total violations**: ~190 (162 require-await + 28 banned eslint-disable)
**Files affected**: ~135
**Detailed issue list**: `docs/plans/pr-bot-punchlist.md`

---

## Root Cause

The obsidian-releases bot uses a stricter scanner than the published `eslint-plugin-obsidianmd@0.1.9`:
- `@typescript-eslint/require-await` is OFF in the npm plugin but ON in the bot
- The bot restricts which rules can be disabled via inline `eslint-disable` comments
- The bot requires descriptions on all `eslint-disable` directives

**ESLint config update** (Task #1) closes the detection gap so these show up locally. The fixes below address the actual violations.

---

## Phase Overview

| Phase | What | Files | Violations | Effort | Dependencies |
|-------|------|-------|------------|--------|--------------|
| 0 | ESLint config update | 1 | — | Done (Task #1) | None |
| 1 | Remove Node.js inline disables | 15 | 17 | Low | Phase 0 |
| 2 | Fix banned eslint-disable comments | 8 | 11 | Medium | None |
| 3 | Fix require-await violations | 135 | 162 | Medium-High | None |

Phases 1-3 are independent and can run concurrently.

---

## Phase 1: Remove `import/no-nodejs-modules` Inline Disables

**Why**: The bot rejects all inline `eslint-disable import/no-nodejs-modules` comments. Phase 0 adds config-level exemptions for these files, making the inline comments unnecessary.

**Fix**: Delete the `eslint-disable` comments. The config-level override handles it.

**Files** (15 files, 17 comments to remove):
```
src/server/transport/HttpTransportManager.ts         (2 comments)
src/server/transport/IPCTransportManager.ts           (2 comments)
src/server/transport/StdioTransportManager.ts         (1 comment)
src/services/chat/MessageQueueService.ts              (1 comment)
src/services/embeddings/IndexingQueue.ts              (1 comment)
src/services/external/ClaudeCodeAuthService.ts        (1 comment)
src/services/external/ClaudeHeadlessService.ts        (1 comment)
src/services/external/GeminiCliAuthService.ts         (1 comment)
src/services/llm/adapters/anthropic-claude-code/AnthropicClaudeCodeAdapter.ts (1 comment)
src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts (1 comment)
src/services/llm/adapters/shared/ProviderHttpClient.ts (1 comment)
src/services/oauth/OAuthCallbackServer.ts             (1 comment)
src/settings/getStartedStatus.ts                      (1 comment)
src/utils/cliPathUtils.ts                             (1 comment)
src/utils/cliProcessRunner.ts                         (1 comment)
```

**Agent**: 1 backend-coder. Mechanical find-and-delete.
**Risk**: None — removing dead comments.

---

## Phase 2: Fix Banned eslint-disable Comments (Non-Node.js)

Four sub-tasks, all independent. Can be handled by 1 agent or split across 2-3.

### 2a. Fix sentence-case violations (5 files)

**Rule**: `obsidianmd/ui/sentence-case`
**Problem**: Files disable the rule wholesale instead of fixing the text.
**Fix**: Apply sentence case to all UI text (button labels, headings, setting names). Only the first word and proper nouns are capitalized. Then remove the `eslint-disable` comment.

| File | Action |
|------|--------|
| `src/components/ConfigModal.ts:4` | Remove disable, fix UI text |
| `src/components/llm-provider/providers/LMStudioProviderModal.ts:15` | Remove disable, fix UI text |
| `src/components/llm-provider/providers/OllamaProviderModal.ts:15` | Remove disable, fix UI text |
| `src/settings/tabs/GetStartedTab.ts:17` | Remove disable, fix UI text |
| `src/settings/tabs/PromptsTab.ts:19` | Remove disable, fix UI text |

**Example transforms**: "Save Note" → "Save note", "Create Workspace" → "Create workspace", "API Key" → "API key" (unless "API" is treated as a proper noun by the rule — test each case).

**Agent**: 1 frontend-coder. Requires reading each file to identify all capitalized UI strings.
**Risk**: Low. May need to test the rule's behavior with acronyms (API, LLM, MCP, etc.).

### 2b. Fix file manager trash usage (1 file, 2 instances)

**Rule**: `obsidianmd/prefer-file-manager-trash-file`
**Problem**: `VaultOperations.ts` uses `vault.delete()` or `vault.trash()` and disables the rule inline.
**Fix**: Replace with `this.app.fileManager.trashFile(file)` which respects the user's "Deleted files" preference (trash vs permanent delete). Remove the disable comments.

| File | Lines |
|------|-------|
| `src/core/VaultOperations.ts` | L258, L283 |

**Agent**: 1 backend-coder (can combine with Phase 1 or 2d).
**Risk**: Low. Need access to `this.app` or pass `app` reference. Check existing method signatures.

### 2c. Fix console usage (2 files, 2 instances)

**Rule**: `no-console`
**Problem**: `ServiceAccessor.ts` and `ServiceIntegration.ts` use `console.log/warn/error` with inline disable.
**Fix**: Replace with `StructuredLogger` or remove if the logging is unnecessary.

| File | Line |
|------|------|
| `src/agents/memoryManager/services/ServiceAccessor.ts` | L382 |
| `src/agents/memoryManager/utils/ServiceIntegration.ts` | L437 |

**Agent**: 1 backend-coder (can combine with 2b/2d).
**Risk**: Low. Check what's being logged and whether StructuredLogger is accessible in scope.

### 2d. Fix deprecated type aliases (1 file, 2 instances)

**Rule**: `@typescript-eslint/no-deprecated`
**Problem**: `database/types/index.ts` re-exports deprecated type aliases for backward compatibility.
**Fix**: Remove the deprecated re-exports. Search for any remaining usage and update to new names.

| File | Lines | Deprecated | Replacement |
|------|-------|------------|-------------|
| `src/database/types/index.ts` | L37, L39 | TBD — read file | Use current type names |

**Agent**: 1 backend-coder.
**Risk**: Medium — need to verify no remaining consumers. `grep` for the deprecated names first.

---

## Phase 3: Fix `require-await` Violations (162 instances, 135 files)

This is the bulk of the work. The violations fall into clear patterns.

### Fix Strategy

For each `async` method without `await`:

| Situation | Fix | Example |
|-----------|-----|---------|
| Method doesn't need to be async | Remove `async` keyword | `getModelPricing()` returning static data |
| Implements async interface/base class | Remove `async`, wrap return in `Promise.resolve()` | `async listModels(): Promise<Model[]> { return [...] }` → `listModels(): Promise<Model[]> { return Promise.resolve([...]) }` |
| Multiple returns in complex method | Use `// eslint-disable-next-line @typescript-eslint/require-await -- {reason}` | Only if `Promise.resolve()` wrapping would hurt readability |

**Bot compatibility note**: The bot does NOT block disabling `require-await` (it's not in the banned list). So `eslint-disable-next-line` with a description is a valid escape hatch for interface implementations, but `Promise.resolve()` is preferred.

### Sub-task Breakdown by Domain

| Batch | Directory | Violations | Agent | Notes |
|-------|-----------|------------|-------|-------|
| 3a | `src/services/llm/adapters/` | 54 | backend-coder-1 | Largest batch. `listModels`, `getModelPricing` across 15 adapters. All follow the same pattern — check base class contract. |
| 3b | `src/handlers/` | 19 | backend-coder-2 | Handler services + strategies. Schema providers, validation, tool help. |
| 3c | `src/agents/` | 25 | backend-coder-3 | searchManager (11), memoryManager (7), apps (3), promptManager (3), storageManager (1) |
| 3d | `src/database/` | 18 | backend-coder-4 | SQLiteCacheManager (10), repositories (4), services (3), schema (1). These wrap better-sqlite3's synchronous API. |
| 3e | `src/ui/` + `src/components/` | 13 | frontend-coder | Chat view, suggesters, task board, settings renderers. Obsidian lifecycle methods (`onOpen`, `onClose`). |
| 3f | `src/core/` + `src/server/` + `src/services/` (remaining) | 33 | backend-coder-5 | ServiceManager, VaultOperations, BackgroundProcessor, ServiceRegistrar, UsageTracker, AgentInitializationService, etc. |

### Interface Contract Check (Critical Pre-Step)

Before fixing, agents must identify which methods are constrained by interface/base class contracts:

```bash
# Check base class signatures for common patterns
grep -n 'abstract.*async\|async.*abstract' src/agents/baseTool.ts src/agents/baseAgent.ts
grep -n 'abstract.*listModels\|abstract.*getModelPricing\|abstract.*execute' src/services/llm/adapters/BaseLLMAdapter.ts
```

If the base class declares `async abstract listModels()`, then implementations MUST be async. In that case:
- **Best fix**: Remove `async` from the BASE CLASS declaration too (if it doesn't await either)
- **If base class has subtypes that DO await**: Keep base class async, use `Promise.resolve()` wrapper in implementations that don't

### Parallel Dispatch Strategy

Batches 3a-3f have NO file overlap. Dispatch all 6 agents concurrently:
- 3a + 3b + 3c + 3d: 4 backend-coders
- 3e: 1 frontend-coder
- 3f: 1 backend-coder

Total: 5 backend-coders + 1 frontend-coder running in parallel.

---

## Execution Order

```
Phase 0: ESLint config update          ←— in progress (Task #1)
    ↓
Phase 1: Remove Node.js inline disables    (1 agent, ~15 min)
Phase 2a-d: Fix other banned disables      (1-2 agents, ~30 min)
Phase 3a-f: Fix require-await              (6 agents parallel, ~45 min)
    ↓ (all phases can run concurrently after Phase 0)
    ↓
Verify: npm run lint passes clean
Commit + push to ProfSynapse/nexus
Bot rescans within 6 hours
```

**Recommended workflow**: `/PACT:comPACT` with 7-8 concurrent specialists.

---

## Verification

After all fixes:
```bash
# Must pass clean (exit 0, no output)
npm run lint

# Double-check require-await specifically
npx eslint --rule '{"@typescript-eslint/require-await": "error"}' src/ 2>&1 | grep -c require-await
# Expected: 0

# Confirm no banned eslint-disable comments remain
grep -rn 'eslint-disable.*no-nodejs-modules\|eslint-disable.*sentence-case\|eslint-disable.*prefer-file-manager\|eslint-disable.*no-console\|eslint-disable.*no-deprecated' src/
# Expected: no output

# Build still passes
npm run build
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Removing `async` breaks callers expecting `Promise` | Low | High | Check each call site — TypeScript compiler catches most |
| Sentence case breaks UX (user-facing text changes) | Low | Medium | Visual review in Obsidian after fix |
| `fileManager.trashFile()` API differs from `vault.delete()` | Low | Medium | Test deletion behavior in dev |
| Base class `async` removal cascades | Medium | Medium | Check ALL implementations before modifying base class |

---

## Relationship to Existing Punchlist

`docs/plans/eslint-punchlist.md` covers ALL ESLint violations (570 original). This plan covers only the ~190 violations the obsidian-releases bot flags as "Required." The two overlap:
- eslint-punchlist Group A (Obsidian compliance, 93) → partially covered here (sentence-case, trash-file)
- eslint-punchlist Group C (Node.js imports, 27) → fully covered here (Phase 1)
- eslint-punchlist Group D (Async/Promise, 83) → `require-await` is a NEW category not in the original punchlist

After fixing this plan's violations, update `eslint-punchlist.md` counts accordingly.
