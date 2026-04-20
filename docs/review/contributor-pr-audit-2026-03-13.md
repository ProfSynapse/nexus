# Contributor PR Audit — 2026-03-13

Audit of 5 open PRs from **gcp007-ops**, all targeting `main`.

---

## PR #45 — `fix: move pipe setup inside socket connect handler`
**Branch:** `fix/connector-pipe-on-connect` | **File:** `connector.ts` | **+12 / -19**

### Summary
Moves `process.stdin.pipe(socket)` and `socket.pipe(process.stdout)` from immediately after `createConnection()` into the `socket.on('connect')` handler. Also removes a duplicate `socket.on('connect')` handler and deduplicates retry logic in the `close` handler.

### Analysis

**The problem is real.** `net.createConnection()` returns a socket that hasn't connected yet. Piping stdin/stdout before the `connect` event means data could be written to an unconnected socket, and on slow/unreliable local connections this can cause silent data loss or EPIPE errors.

**Code quality:**
- Consolidates two separate `socket.on('connect', ...)` handlers into one (good cleanup)
- Removes duplicate `retryCount = 0` and `setTimeout(connectWithRetry, 1000)` in the close handler
- Clean, minimal diff

**Concern — stdin unpipe on close:**
The current code has `process.stdin.unpipe(socket)` in the `close` handler — this is important because after a close, if the pipe was set up, stdin would otherwise stay piped to a dead socket. This must be preserved in the PR. From the diff it appears the close handler still has `process.stdin.unpipe(socket)`, so this is fine.

**Concern — error handler race:**
If `error` fires before `connect` (the common case for ENOENT/ECONNREFUSED), the pipes haven't been set up yet, so the error handler's retry path is clean. Good.

### Verdict: **APPROVE**
Clean, correct fix for a real timing issue. No regressions. The code is simpler after this change.

---

## PR #46 — `fix: WorkspacePromptResolver reads from SQLite storage service`
**Branch:** `fix/workspace-prompt-resolver-sqlite` | **Files:** 4 | **+29 / -20**

### Summary
Threads `CustomPromptStorageService` from `AgentInitializationService` → `MemoryManagerAgent` → `LoadWorkspaceTool` → `WorkspacePromptResolver`. The resolver now tries `CustomPromptStorageService.getPromptByNameOrId()` first (SQLite-backed), falling back to direct `data.json` reads.

### Analysis

**The problem is real.** Currently `WorkspacePromptResolver.fetchPromptByNameOrId()` reads prompts exclusively from `plugin.settings.settings.customPrompts.prompts[]` (the in-memory data.json). If prompts were created/modified through the SQLite-backed `CustomPromptStorageService`, they wouldn't be visible during workspace loading.

**Code quality:**
- All new parameters are optional (`?`) — no breaking changes
- Fallback chain is correct: service first → data.json fallback
- The `customPromptStorage` property on `MemoryManagerAgent` is declared `public readonly` — acceptable since `LoadWorkspaceTool` needs to read it

**Concern — `this.customPromptStorage` in AgentInitializationService:**
The PR passes `this.customPromptStorage` to the `MemoryManagerAgent` constructor. Looking at the current code, `this.customPromptStorage` is a private field on `AgentInitializationService` that may be `undefined` at the time `initializeMemoryManager()` runs (it's lazily created in `initializePromptManager()`). The initialization order matters here.

**Question:** Is `initializePromptManager()` always called before `initializeMemoryManager()`? If not, the service will be `undefined` and the resolver falls back to data.json (which is the current behavior, so no regression — but the fix wouldn't activate).

**Concern — `getPromptByNameOrId` API:**
Need to verify this method exists on `CustomPromptStorageService`. The PR assumes it does. If it doesn't exist, this is a compile-time error that would be caught by `npm run build`.

### Verdict: **APPROVE WITH COMMENT**
Correct approach with proper fallback. Request the contributor verify initialization order (PromptManager before MemoryManager) and confirm `getPromptByNameOrId()` exists on the service. No risk of regression since it falls back gracefully.

---

## PR #47 — `fix: SettingsView reuses CustomPromptStorageService from ServiceManager`
**Branch:** `fix/settings-view-service-manager` | **File:** `src/settings/SettingsView.ts` | **+9 / -2**

### Summary
Instead of always creating `new CustomPromptStorageService(null, settingsManager)`, first checks `ServiceManager.getServiceIfReady<CustomPromptStorageService>('customPromptStorageService')` for an initialized instance with database connectivity.

### Analysis

**The problem is real.** The current code creates a `CustomPromptStorageService` with `null` for the database, meaning SettingsView always writes to data.json only. Other parts of the app read from SQLite, causing synchronization divergence.

**Code quality:**
- Uses `getServiceIfReady()` which is non-blocking and returns `null` if the service isn't ready — safe
- Falls back to the current behavior (`new CustomPromptStorageService(null, ...)`) when ServiceManager isn't available
- Minimal, focused diff

**Concern — service name string:**
The string `'customPromptStorageService'` must exactly match the key used when registering the service in ServiceManager. A typo here would silently fall through to the fallback. This should be verified.

**Concern — stale reference:**
If SettingsView stores the reference and the service is later replaced/rebuilt, the stored reference could become stale. However, `getCurrentServices()` is called each time the settings tab is rendered, so this is a non-issue in practice.

### Verdict: **APPROVE WITH COMMENT**
Clean fix. Verify the service registration key matches `'customPromptStorageService'` exactly.

---

## PR #48 — `fix: proactive transport cleanup prevents reconnection race condition`
**Branch:** `fix/ipc-transport-cleanup` | **File:** `src/server/transport/IPCTransportManager.ts` | **+49 / -18**

### Summary
Adds a `currentTransport` instance field to track the active `StdioServerTransport` in single-client mode. Before wiring a new connection, explicitly closes the previous transport with a 500ms timeout guard. Also cleans up `currentTransport` in `stopTransport()`.

### Analysis

**The problem is plausible but nuanced.** The race condition described (old transport's `onclose` firing after new transport is wired, nullifying `Protocol._transport`) requires:
1. A connector disconnects and reconnects rapidly
2. The old socket's `close`/`end` event fires after the new socket connects
3. The old transport's `onclose` handler calls `transport.close()` which nullifies the shared Protocol's `_transport`

In the current code, the transport is local to `handleSingleClientConnection()` and captured in a closure. The `onSocketGone` callback only closes *that specific transport instance*, not the new one. So the described race condition where the old handler "nullifies Protocol._transport on the new connection" would only happen if `StdioTransportManager.connectSocketTransport()` shares a single Protocol instance and `transport.close()` detaches from it.

**This depends on MCP SDK internals.** If `Protocol._transport` is set to `null` when *any* connected transport closes (not just the currently active one), then this fix is correct. If the Protocol only nullifies its transport reference when the *currently connected* transport closes, then this fix is unnecessary (but still harmless).

**Code quality:**
- The 500ms timeout guard on old transport close is a reasonable safety measure
- Making `handleSingleClientConnection` async is fine
- Adding `currentTransport` cleanup in `stop()` is good hygiene

**Concern — multi-client path not addressed:**
This only fixes the single-client (`handleSingleClientConnection`) path. The multi-client path (`handleMultiClientConnection`) has separate per-connection servers, so the race doesn't apply there. This is correct and focused.

**Concern — `handleSocketConnection` signature change:**
The diff shows `handleSocketConnection` going from `void` to `async Promise<void>`. Since `createServer()` callback ignores the return value, this is fine — but the `async` propagation should be consistent.

### Verdict: **APPROVE WITH COMMENT**
Defensive fix that addresses a legitimate (if edge-case) race condition in the single-client transport path. The timeout guard is reasonable. Verify with MCP SDK that Protocol._transport nullification happens per-transport-close, not per-Protocol-close, to confirm the full necessity. Either way, the cleanup hygiene is an improvement.

---

## PR #49 — `feat: add find-and-replace mode to contentManager.update`
**Branch:** `feat/content-find-replace` | **Files:** 3 | **References issue #33**

### Summary
Adds an alternative operating mode to the `update` tool accepting `{find, replace, occurrence?}` parameters alongside the existing `{startLine, endLine, content}`. Mode is auto-detected by parameter presence. Uses split/join instead of regex.

### Analysis

**The feature request is valid.** Issue #33 identifies a real UX problem: line-based updates shift line numbers, requiring a fresh `read` before each edit in multi-edit workflows. Content-based find-replace avoids this entirely.

**Architecture fit:**
- The legacy `findReplaceContent` tool was removed in the CRUA simplification, but its functionality is missed
- Adding it as a mode within the existing `update` tool (rather than a separate tool) aligns with the 3-tool CRUA philosophy
- Auto-detection via parameter presence is clean — no `mode` enum needed

**Code quality (from partial diff — update.ts/types.ts diffs weren't fully visible):**
- Description updated to document both modes
- Uses split/join methodology (avoids regex escaping bugs)
- `occurrence` parameter (default: 1, or "all") provides fine-grained control
- Case-sensitive matching is a reasonable default

**Concerns:**

1. **Type safety:** The `UpdateParams` interface needs `find`, `replace`, and `occurrence?` fields added. These should be optional to maintain backward compatibility. Since `content` and `startLine` are currently `required` in the schema, the find-replace mode parameters must also handle the case where `content`/`startLine` are absent. The schema's `required` array likely needs updating to not require `startLine` and `content` when in find-replace mode — this may require `oneOf`/`anyOf` in the JSON schema.

2. **Parameter collision:** What happens if someone passes both `find` AND `startLine`? The auto-detection logic needs a clear precedence rule and should ideally error if both modes' parameters are provided simultaneously.

3. **Security:** The split/join approach is safe against regex injection. Good.

4. **linesDelta return:** Find-replace operations change line counts when the replacement has a different number of newlines. The implementation should calculate and return `linesDelta` accurately for this mode too.

5. **Empty find string:** Should be validated — an empty `find` would match everywhere with split/join.

6. **Missing tests:** No test files are included in the PR. Given this is a feature addition with multiple edge cases (occurrence targeting, empty find, multi-line strings, not-found cases), tests are strongly recommended before merge.

### Verdict: **REQUEST CHANGES**
Good feature direction, but needs:
1. Clarify JSON schema handling (can't require `startLine`/`content` when in find-replace mode)
2. Add validation for parameter collision (both modes specified)
3. Add validation for empty `find` string
4. Add unit tests covering: basic find-replace, occurrence targeting, "all" occurrences, not-found case, multi-line find/replace, linesDelta accuracy, parameter collision error
5. Verify `UpdateParams` type changes compile cleanly

---

## Summary Table

| PR | Title | Verdict | Risk | Priority |
|----|-------|---------|------|----------|
| **#45** | Move pipe inside connect handler | **Approve** | Low | Medium |
| **#46** | WorkspacePromptResolver SQLite | **Approve w/ comment** | Low | Medium |
| **#47** | SettingsView reuse service | **Approve w/ comment** | Low | Medium |
| **#48** | IPC transport cleanup | **Approve w/ comment** | Low | Low |
| **#49** | Find-replace mode for update | **Request changes** | Medium | High |

### Merge Order Recommendation
1. **#45** (standalone, no dependencies)
2. **#47** then **#46** (47 wires the service in SettingsView; 46 extends it to WorkspacePromptResolver — independent but related)
3. **#48** (standalone transport fix)
4. **#49** (needs rework before merge)

### Notes on Contributor
All 5 PRs from **gcp007-ops** are well-motivated, target real issues, and follow the existing code patterns. The contributor understands the codebase architecture (DI via ServiceManager, fallback chains, CRUA tool pattern). PR #49 is ambitious and needs iteration, but the remaining 4 are clean and mergeable after minor verification.
