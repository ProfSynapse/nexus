# ESLint Punchlist
Generated: 2026-04-01 | Starting violations: 663 | After `--fix`: 570 (563 errors, 7 warnings)

`--fix` resolved ~93 issues automatically (unnecessary type assertions, `no-var`, `no-empty-interface`).

---

## Status

| Group | Category | Count | Priority |
|-------|----------|-------|----------|
| A | Obsidian plugin compliance | 93 | HIGH — plugin store |
| B | Real bugs | 32 | HIGH — correctness |
| C | Node.js imports | 27 | MEDIUM — needs eslint-disable |
| D | Async/Promise issues | 83 | MEDIUM — potential runtime bugs |
| E | Type safety (any leakage) | 175 | LOW — will shrink after TS migration |
| F | Unused variables | 103 | LOW — cleanup |
| G | Minor / misc | 5 | LOW |

**Prerequisite**: Fix TS build errors first (`docs/plans/any-to-unknown-type-migration-plan.md`). Group E (175 violations) will shrink significantly once the `any`→`unknown` migration is complete.

---

## Group A — Obsidian Plugin Compliance (93) 🔴

### A1. `sentence-case` (74 violations) — 21 files
UI text must use sentence case: "Save Note" → "Save note", "Create Workspace" → "Create workspace".

Files to update:
- `src/agents/ingestManager/ui/IngestConfirmModal.ts`
- `src/components/shared/ChatSettingsRenderer.ts`
- `src/components/shared/ModelDropdownRenderer.ts`
- `src/components/workspace/FilePickerRenderer.ts`
- `src/components/workspace/WorkflowEditorRenderer.ts`
- `src/components/workspace/WorkspaceFormRenderer.ts`
- `src/core/commands/InlineEditCommandManager.ts`
- `src/core/commands/MaintenanceCommandManager.ts`
- `src/core/ui/ChatUIManager.ts`
- `src/core/ui/TaskBoardUIManager.ts`
- `src/services/llm/core/StreamingOrchestrator.ts`
- `src/settings/tabs/AppsTab.ts`
- `src/settings/tabs/DataTab.ts`
- `src/settings/tabs/ProvidersTab.ts`
- `src/ui/chat/builders/ChatLayoutBuilder.ts`
- `src/ui/chat/components/ContextProgressBar.ts`
- `src/ui/chat/components/ConversationTitleModal.ts`
- `src/ui/chat/controllers/UIStateController.ts`
- `src/ui/experimental/ClaudeHeadlessModal.ts`
- `src/ui/tasks/TaskBoardView.ts`
- `src/utils/WasmEnsurer.ts`

> Rule: Only the first word and proper nouns are capitalized. Button labels, setting names, modal headings.

### A2. `prefer-file-manager-trash-file` (7 violations) — 1 file
Replace `vault.delete()` / `vault.trash()` with `fileManager.trashFile()` to respect user's deletion preference.

- `src/core/VaultOperations.ts` — 7 occurrences

### A3. `hardcoded-config-path` (5 violations) — 2 files
Replace hardcoded `'.obsidian'` with `vault.configDir`.

- `src/agents/apps/webTools/WebToolsAgent.ts`
- `src/utils/PathManager.ts`

### A4. `no-tfile-tfolder-cast` (5 violations) — 1 file
Replace direct `as TFolder`/`as TFile` casts with `instanceof` narrowing.

- `src/agents/searchManager/services/DirectoryItemCollector.ts` (lines 115, 120)

> Pattern: `if (file instanceof TFolder) { /* file is TFolder here */ }` instead of `file as TFolder`

### A5. `no-plugin-name-in-command-name` (1 violation)
Remove plugin name prefix from command title — Obsidian already shows it.

- `src/core/ui/ChatUIManager.ts:108`

### A6. `no-manual-html-headings` (1 violation) — settings tab
Use Obsidian's `containerEl.createEl('h2', ...)` heading API instead of raw `<h2>` HTML.

- Likely in a settings tab — run lint with `-f unix` to find exact line.

---

## Group B — Real Bugs (32) 🔴

### B1. `only-throw-error` (13 violations) — multiple adapter files
Throwing strings or plain objects instead of `Error` instances. Breaks `catch (e: Error)` type narrowing and stack traces.

Fix: `throw result.error` → `throw new Error(result.error)` (or `throw new Error(String(result.error))`)

Files:
- `src/services/llm/adapters/openai/OpenAIAdapter.ts`
- `src/services/llm/adapters/openrouter/OpenRouterAdapter.ts`
- `src/services/llm/adapters/groq/GroqAdapter.ts`
- `src/services/llm/adapters/mistral/MistralAdapter.ts`
- `src/services/llm/adapters/perplexity/PerplexityAdapter.ts`
- `src/services/llm/adapters/requesty/RequestyAdapter.ts`
- `src/services/llm/adapters/openai-codex/OpenAICodexAdapter.ts`
- `src/services/llm/adapters/webllm/WebLLMAdapter.ts`
- `src/handlers/strategies/ToolExecutionStrategy.ts` (or similar handlers file)

### B2. `no-alert` (3 violations) — confirm() calls
`confirm()` is browser-native and bypasses Obsidian's UI. Replace with `new Notice(...)` or a custom modal.

Files:
- `src/components/workspace/WorkspaceListRenderer.ts`
- `src/settings/tabs/WorkspacesTab.ts`
- `src/ui/chat/components/ConversationList.ts` or `ContextProgressBar.ts`

### B3. `no-restricted-globals` — localStorage (3 violations)
Direct `localStorage` access doesn't scope to the vault. Use `App#saveLocalStorage` / `App#loadLocalStorage`.

Files:
- `src/database/services/ExportService.ts`
- `src/database/storage/JSONLWriter.ts`

### B4. `no-deprecated` (13 violations) — deprecated Obsidian/JS APIs
Sub-items:

**`substr` → `substring`** (9 occurrences across multiple adapter files):
- `src/services/llm/adapters/openai/OpenAIAdapter.ts`
- `src/services/llm/adapters/openrouter/OpenRouterAdapter.ts`
- `src/services/llm/adapters/groq/GroqAdapter.ts`
- `src/services/migration/DataTransformer.ts`
- Others — search: `grep -rn '\.substr(' src/`

**Deprecated Obsidian state types** (use new names):
- `StateSnapshot` → `StateContext` — `src/types/migration/MigrationTypes.ts`
- `WorkspaceStateSnapshot` → `WorkspaceState` — `src/services/workspace/WorkspaceSessionService.ts`, `WorkspaceStateService.ts`
- `stateId` → `name` — 1 occurrence

**Workspace API**:
- `Workspace.getLeaf` deprecated — use `workspace.getLeaf(false)` or the new leaf API (1 occurrence)

### B5. `depend/ban-dependencies` (2 violations) — package.json
Linter flags `builtin-modules` and `axios` as banned packages.

- `builtin-modules`: Used in `esbuild.config.mjs` to exclude Node builtins. Needed — add `// eslint-disable` comment in `package.json` or exclude `package.json` from the depend rule.
- `axios`: Replace with native `fetch`/`requestUrl()` if any direct axios usage remains. (Most HTTP already routes through `ProviderHttpClient` using `requestUrl`.)

Action: Likely safe to add `eslint-disable` comments or exclude `package.json` from the `depend` rule since these are build-time, not runtime imports.

---

## Group C — Node.js Imports (27 violations) 🟡

Rule `import/no-nodejs-modules` fires on any `child_process`, `net`, `path`, etc. import. These are all intentional desktop-only features — they need `// eslint-disable-next-line import/no-nodejs-modules` comments (or `/* eslint-disable */` blocks) with a justification.

Files needing disable comments:
- `src/server/services/ServerConfiguration.ts`
- `src/server/transport/HttpTransportManager.ts`
- `src/server/transport/IPCTransportManager.ts`
- `src/server/transport/StdioTransportManager.ts`
- `src/services/chat/MessageQueueService.ts`
- `src/services/embeddings/IndexingQueue.ts`
- `src/services/external/ClaudeCodeAuthService.ts`
- `src/services/external/ClaudeHeadlessService.ts`
- `src/services/external/GeminiCliAuthService.ts`
- `src/services/llm/adapters/anthropic-claude-code/AnthropicClaudeCodeAdapter.ts`
- `src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts`
- `src/services/llm/adapters/shared/ProviderHttpClient.ts`
- `src/services/oauth/OAuthCallbackServer.ts`
- `src/settings/getStartedStatus.ts`
- `src/utils/cliPathUtils.ts`
- `src/utils/cliProcessRunner.ts`

> Template: `// eslint-disable-next-line import/no-nodejs-modules -- desktop-only, guarded by isDesktopApp()`

> Alternative: Add an override in `eslint.config.mjs` for `src/server/**` and `src/services/external/**` to disable the rule for those directories.

---

## Group D — Async/Promise Issues (83) 🟡

These may cause silent failures or uncaught rejections at runtime.

### D1. `no-floating-promises` (37 violations)
Unhandled promise chains — async calls whose rejections are swallowed.

Fix: Add `void` prefix for intentionally fire-and-forget, or add `.catch()` handler:
```typescript
void someAsync();           // intentional fire-and-forget
await someAsync();          // properly awaited
someAsync().catch(console.error);  // handled rejection
```

### D2. `no-misused-promises` (34 violations)
Async functions assigned where void callbacks are expected (e.g., event handlers, `forEach`).

Common patterns:
```typescript
// Bad: async function in DOM event handler
button.addEventListener('click', async () => { ... });

// Fix: wrap in void
button.addEventListener('click', () => { void handler(); });

// Bad: async in forEach
items.forEach(async (item) => { ... });

// Fix: use for...of
for (const item of items) { await processItem(item); }
```

### D3. `await-thenable` (5 violations)
Awaiting a non-Promise value. Remove unnecessary `await`.

### D4. `unbound-method` (6 violations)
Passing class methods as callbacks without binding. Fix: use arrow functions or `.bind(this)`.

### D5. `prefer-promise-reject-errors` (2 violations)
`Promise.reject(value)` called with non-Error. Use `Promise.reject(new Error(message))`.

---

## Group E — Type Safety / any Leakage (175) 🟢

**These will shrink significantly once the `any`→`unknown` TS migration is complete.** Tackle after the build is passing.

| Rule | Count | Notes |
|------|-------|-------|
| `no-unsafe-assignment` | 71 | Assigning `any` to typed vars |
| `restrict-template-expressions` | 36 | `unknown`/`never` in template literals — add explicit `.toString()` or cast |
| `no-unsafe-member-access` | 35 | Accessing properties on `any` |
| `no-redundant-type-constituents` | 22 | `T \| unknown` → just `unknown`; `T \| never` → just `T` |
| `no-base-to-string` | 21 | Objects in template literals with no `toString()` — add type guards |
| `no-unsafe-return` | 16 | Returning `any` from typed function |
| `no-unsafe-argument` | 14 | Passing `any` to typed parameter |
| `no-unsafe-call` | 5 | Calling a value typed as `any` |
| `no-unsafe-enum-comparison` | 6 | Comparing enum to `any` — use typed comparison |
| `no-unsafe-declaration-merging` | 2 | Interface + class declaration merging with unsafe types |

---

## Group F — Unused Variables (103) 🟢

Most are unused `error` in catch blocks. Easy fix: rename to `_error` or `_e`.

Pattern:
```typescript
// Before:
} catch (error) {
  return null;
}

// After:
} catch (_error) {
  return null;
}
```

Files with unused vars (partial — run lint to get full list):
- `src/agents/memoryManager/services/WorkspaceFileCollector.ts`
- `src/agents/searchManager/services/` (multiple)
- `src/agents/storageManager/utils/FileOperations.ts`
- `src/connector.ts`
- `src/core/ObsidianPathManager.ts`
- `src/database/migration/LegacyFileScanner.ts`
- `src/handlers/services/` (multiple)
- `src/server/services/AgentRegistry.ts`
- `src/services/agent/AgentRegistrationService.ts`
- `src/services/llm/` (multiple adapters)
- `src/ui/chat/services/` (multiple)
- `src/utils/` (directoryTreeUtils, filterUtils, ProviderInfoService)
- And ~25 more — search: `npm run lint 2>&1 | grep 'no-unused-vars' -B1 | grep '\.ts'`

---

## Group G — Minor / Misc (5) 🟢

| Rule | Count | Fix |
|------|-------|-----|
| `no-unused-expressions` | 2 | Remove or assign the expression result |
| `restrict-plus-operands` | 1 | Explicit toString before `+` concatenation |
| `no-require-imports` | 1 | Replace `require()` with `import` |
| `no-empty-object-type` | 1 | Replace `{}` type with `Record<string, never>` or `object` |

---

## Recommended Order of Attack

1. **Fix TS build** (`any`→`unknown` migration plan) — unblocks Group E
2. **Group A** (Obsidian compliance, 93) — plugin store requirement
3. **Group B** (Real bugs, 32) — correctness, especially B1/B2/B3
4. **Group F** (Unused vars, 103) — mechanical, safe, reduces noise
5. **Group C** (Node.js imports, 27) — add eslint-disable comments
6. **Group D** (Async/Promise, 83) — requires careful review per-file
7. **Group E** (Type safety, 175) — tackle after TS migration clears most of it
8. **Group G** (Minor, 5) — last

---

## Quick Commands

```bash
# See current count
npm run lint 2>&1 | tail -3

# See violations for one file
npx eslint src/path/to/file.ts

# See all files with a specific rule
npm run lint 2>&1 | grep 'rule-name' -B1 | grep '\.ts' | sort -u

# Re-run auto-fix (safe to run again)
npm run lint -- --fix
```
