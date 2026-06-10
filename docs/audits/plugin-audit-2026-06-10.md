# Nexus Plugin Audit — 2026-06-10

**Scope**: full source tree at `acf95d3` (v5.11.1). Four parallel audit passes — security, Obsidian/mobile compliance, technical debt/architecture, dependencies/build/release — with the highest-impact claims hand-verified against the code.

**Headline**: the plugin is in good shape on the fundamentals — 0 npm-audit vulnerabilities (prod + dev), `strict: true` TypeScript, fully parameterized SQL, zip-slip and skill-path traversal guards in place, clean mobile boot path, CI-built attested releases, no shipped sourcemaps. The real risks are concentrated in a handful of specific, fixable items below.

---

## 1. Priority findings (fix these first)

### P1 — Security

| # | Finding | Location | Severity |
|---|---------|----------|----------|
| S1 | **MCP IPC socket is world-writable.** `fs.chmod(ipcPath, 0o666)` on the Unix domain socket means any local user/process on macOS/Linux can connect to the unauthenticated MCP socket and execute vault tools (read/write/delete notes, run analysis). Windows named pipes get default per-user ACLs, so this is Unix-specific. | `src/server/transport/IPCTransportManager.ts:250` (verified) | **High** |
| S2 | **Unpinned remote code import.** `await import('https://esm.run/@mlc-ai/web-llm')` has no version pin — esm.run serves *latest*, so a compromised or broken upstream publish executes immediately in every user's Electron renderer with vault access. Related drift: worker pins `@0.2.78`, doc-comment says 0.2.80, package.json says `^0.2.84`. | `src/services/llm/adapters/webllm/WebLLMEngine.ts:298` (verified); `WebLLMWorkerService.ts:81` | **High** |
| S3 | **No runtime validation of LLM-supplied tool arguments.** Tool JSON schemas are documentation only (no ajv); `ToolCallRouter.route()` passes `request.params.arguments` straight to handlers. Some tools guard well (ContentManager `write`/`replace`), others don't (`executePrompts` ActionExecutor assumes result shape at line 16; `createTask` has no title guard before the service). Known class of bug (the `notePath: undefined` incident, PR #236). | `src/services/mcp/ToolCallRouter.ts:100-131`; per-tool gaps in §3 | **Medium** |
| S4 | **Web tools accept any URL scheme from the LLM** — no filtering of `file://` or localhost/internal hosts before handing to the web viewer. | `src/agents/apps/webTools/tools/openWebpage.ts` | **Medium** |
| S5 | **API keys/credentials stored in plaintext `data.json`.** This is the Obsidian-ecosystem norm (plugins have no secure-storage API; Electron `safeStorage` is not exposed, and mobile has no equivalent), so graded as accepted-risk rather than a defect. Mitigations: a settings-UI warning that keys live in the vault folder and sync/backups include them. | `src/settings.ts` saveSettings; `llmProviders[*].apiKey`, `apps[*].credentials` | **Medium (accepted-risk, document it)** |

**Recommended fixes**
- S1: `chmod 0o600`; optionally add a connection nonce/token to the IPC handshake for defense-in-depth.
- S2: pin `https://esm.run/@mlc-ai/web-llm@<exact-version>` and reconcile the three referenced versions to one constant. Consider SHA-256 verification of the runtime-downloaded `sqlite3.wasm` (`WasmEnsurer.ts` already pins `@0.0.19`, which is good).
- S3: per the project's own rule (guards live in the service/normalizer layer, not schemas), add a small `ToolParamValidator` (`requireString`, `requireArray`, …) and apply it to the ~20 highest-risk tool `execute()` entry points. No ajv needed.
- S4: allowlist `http:`/`https:` and reject localhost/private-range hosts in `openWebpage`/`capturePagePdf`/`capturePagePng`/`captureToMarkdown`.

### P2 — Release pipeline correctness

| # | Finding | Location | Severity |
|---|---------|----------|----------|
| R1 | **`versions.json` is frozen at 5.9.7** while the current release is 5.11.1. Root cause: the npm `version` script calls `version-bump.mjs`, **which does not exist in the repo**, and the `/nexus-release` skill never touches `versions.json`. Benign today only because `minAppVersion` hasn't changed since 5.9.4; it silently breaks older-Obsidian compatibility resolution the next time it does. | `package.json:12` (verified); `versions.json` (verified) | **Medium** |
| R2 | **No release-time validation** that git tag == `manifest.json.version` == `package.json.version`, nor that `versions.json` covers the release. | `.github/workflows/release.yml` | **Medium** |
| R3 | Actions pinned by tag, not SHA — `softprops/action-gh-release@v2` especially (third-party, `contents: write`). | `.github/workflows/release.yml` | Low |

**Recommended fixes**: restore `version-bump.mjs` (or fold versions.json maintenance into the `/nexus-release` skill), backfill the 5.10.x/5.11.x entries, and add a one-line CI guard (`node -e "if(require('./manifest.json').version!==process.env.TAG)process.exit(1)"`). SHA-pin the release action.

### P3 — Dependency & repo hygiene (cheap, high-yield)

| # | Finding | Detail |
|---|---------|--------|
| D1 | **Unused prod dependencies** (all verified — zero imports): `winston`, `tough-cookie`, `uuid` (only "import" is in the dead `.backup` file; real code uses `src/utils/uuid.ts`), `@mlc-ai/web-llm` (loaded from CDN, types are hand-written), `@huggingface/transformers` (loaded from CDN inside the embedding iframe). Removing `@huggingface/transformers` alone drops `sharp` (+33 platform binaries), `onnxruntime-node`, and `protobufjs` — 3 of the 7 install-script packages — from every `npm ci`. ~50+ packages total. |
| D2 | **Dev dep `crypto: ^1.0.1`** is the deprecated npm stub package (not Node's built-in) — a supply-chain confusion hazard. Remove. `@types/request` also stale. |
| D3 | **Stale committed artifacts** (verified): `main.js.map` (27 MB, v5.9.4-era — prod builds don't even emit maps), `src-compiled.md` (3.7 MB, Dec 2025), `handoff.txt` (agent scratch), `src/agents/memoryManager/services/WorkspaceService.ts.backup`, stale `tool-schemas.json`/`cli-first-tool-schemas.json` (pre-PR-#236 shapes). Untrack all; add `*.map` to `.gitignore`. |
| D4 | `@types/node@^16` vs CI on Node 20.19.0 and `engines >=18` — bump to `^20`. `package.json` `author` is empty and `repository` is missing. `eventsource-parser` 1.1.2 is 2 majors behind and duplicated in-bundle (the MCP SDK nests its own 3.x). |
| D5 | npm audit: **0 vulnerabilities** at any severity, prod and dev (854 packages). MCP SDK at 1.29.0, past the 1.26.0 advisory fixes. No git/URL deps; lockfile v3 with integrity hashes throughout. |

---

## 2. Obsidian / mobile compliance

**Overall: strong.** Verified clean mobile boot path — `main.ts` imports only `obsidian`, `Settings`, `ServiceManager`, `PluginLifecycleManager`; `connector.ts` and OAuth are dynamically imported behind `supportsMCPBridge()`/`Platform.isDesktop`; esbuild marks all Node built-ins external. 139 `registerDomEvent` call sites, ~284 `normalizePath` call sites, comprehensive `shutdown()` with tracked timers, and only one `innerHTML` use (clearing, safe — still prefer `replaceChildren()`).

Should-fix items:

| # | Finding | Location |
|---|---------|----------|
| M1 | **6 unguarded `navigator.clipboard.writeText` calls** — most are `void`-discarded promises with no error handling, so a denied/unfocused clipboard on mobile fails silently (`MessageDisplay.ts:425` is the only one with a `.then`). Not a store blocker, but add a shared `copyToClipboard()` util with try/catch + Notice fallback. | `GetStartedTab.ts:464,511`, `ConfigModal.ts:477`, `GenericProviderModal.ts:232`, `MessageDisplay.ts:425`, `ClaudeHeadlessModal.ts:116` (verified) |
| M2 | **`EmbeddingIframe` window `message` listener** added via raw `addEventListener`; removal depends on `dispose()` running cleanly. Guarantee cleanup (try/finally or `registerDomEvent`). | `src/services/embeddings/EmbeddingIframe.ts:101` |
| M3 | **`ProviderHttpClient` uses raw `fetch`** for non-streaming calls (9 sites). Streaming SSE legitimately needs `fetch`; non-streaming requests should go through `requestUrl()` to avoid mobile CORS issues. | `src/services/llm/adapters/shared/ProviderHttpClient.ts` |
| M4 | 15 `vault.modify()` sites — migrate to `vault.process()` opportunistically (modern best practice, not urgent). | various |
| M5 | `app.plugins` / `app.setting` private-API access — acceptable (feature detection, type-guarded), just keep it contained. | `pluginLocator.ts`, `searchManager.ts`, `CommandDefinitions.ts` |

`manifest.json` is correct (`isDesktopOnly: false`, `minAppVersion: 1.8.7`) — but see R1: `versions.json` doesn't know about anything past 5.9.7.

---

## 3. Technical debt (ranked pay-down list)

The `docs/tech-debt.md` size list is **stale** — current top offenders:

| File | Lines | Was |
|------|------:|----:|
| `src/database/adapters/HybridStorageAdapter.ts` | 1292 | ~600 |
| `src/components/shared/ChatSettingsRenderer.ts` | 1225 | ~700 |
| `src/settings/tabs/DefaultsTab.ts` | 1146 | new |
| `src/ui/chat/ChatView.ts` | 1121 | 659 |
| `ConversationService.ts` | 1052 | 813 |
| …~29 files now exceed the 600-line threshold (also new: `MemorySearchProcessor` 917, `ToolCliNormalizer` 891, `WorkspacesTab` 890, `BaseAdapter` 889, `StorageEvents` 853, `TaskService` 846, `OpenAIAdapter` 821) | | |

**Ranked top 10 (risk × effort × payoff):**

1. **Swallowed errors** (M effort, high payoff). ~50 fully-silent `catch {}` blocks and ~180 console-only catches. Worst hotspots: `SchemaMigrator.ts:258,391` silently skips unparseable rows during migration (data loss with no audit trail); `ToolCallTraceService.ts:116,130,197` returns `undefined` on failure; `ChatSettingsRenderer.ts:630` blanks the UI on error. Fix: shared `ToolErrorHandler.createErrorResult()`, migration-skip counters surfaced to the user, lint rule against empty catch.
2. **Tool param validation gaps** (M) — see S3 above; same work item.
3. **Message type triplication** (M): `ChatMessage` (`types/chat/ChatTypes.ts:21`) vs `ConversationMessage` (`types/storage/StorageTypes.ts:77`) vs `MessageData` (`HybridStorageTypes.ts:295`), converted without guards in `MessageRepository`. Merge to one canonical type with aliases — aligns with the already-planned Canonical Message Pipeline Phase 3/4.
4. **HybridStorageAdapter split** (M): 1292 lines orchestrating all entity CRUD; extract query-building and initialization concerns.
5. **LLM adapter duplication** (S–M): 20+ adapters re-implement status→error-code mapping, SSE chunk extraction, and config validation around `BaseAdapter`. Extract `ErrorCodeMapper` + an `SSEChunkExtractor` interface; ~1500–2000 lines reclaimable.
6. **Adapter test coverage** (M): only DeepSeek has adapter tests; OpenAI/Google/Anthropic/Groq/Mistral have zero. MCP transports and UI controllers also untested. Template exists (`DeepSeekAdapter.test.ts`) — apply to top 5.
7. **Result-shape inconsistency** (S): SearchManager uses `message` where everything else uses `error`; PromptManager throws instead of returning `{success:false}`. Standardize on `CommonResult` with `error: string`.
8. **Storage-root resolution duplicated 4 ways** (S): `PluginStoragePathResolver`, `VaultRootResolver`, `ObsidianPathManager`, plus inline construction in `ServiceManager` (~line 250). Centralize.
9. **Inconsistent error-result shapes in error data/context fields** + multiple Notice helpers (`noticeUtils.showErrorNotice` exists but ~30 sites construct `new Notice()` directly) (S).
10. **Stale TODOs / dead paths** (S): `WorkspacePromptResolver.ts:92,99` TODO(v5.0.0) compat fallbacks (2+ years old), `AdapterRegistry.ts:303` disabled prefetcher, `listStates.ts:127` in-memory sort, plus the D3 artifact debris.

Type safety is otherwise healthy (strict mode on; ~5 `as unknown as` boundary casts, ~0 `as any`, 1 `@ts-expect-error`). The riskiest casts are the event-union casts in `ReconcilePipeline.ts:332-338` and the repo cast in `HybridStorageAdapter.ts:262` — add narrow runtime guards there. Long-term: raise `@typescript-eslint/no-explicit-any` from `warn` to `error` (warnings don't fail `npm run lint`, so `any` can accumulate silently).

---

## 4. What's already good (don't re-fix)

- **SQL**: fully parameterized across all repositories; LIKE patterns bound as params.
- **Path traversal**: `skillPaths.ts` (`resolveVaultPath`/`assertInside`/`isSafePathSegment`) used at every Skills write boundary; PPTX zip extraction normalizes `..` segments (no zip-slip); vault-name sanitization for the IPC path is robust.
- **Pyodide sandbox**: network scrubbing is best-effort by design with the threat model explicitly documented in-file — correctly scoped, no change needed.
- **Secrets in logs**: not logged; adapter error handlers don't serialize request bodies.
- **Markdown rendering**: LLM output goes through Obsidian's renderer / streaming-markdown DOM methods, never `innerHTML`.
- **Build/release**: minified, no shipped sourcemaps, tree-shaken; clean-checkout CI build with provenance attestation; tsconfig `strict: true` with no sub-flag escapes.
- **Mobile architecture**: dynamic-import gating of all Node-dependent code paths; lifecycle shutdown is comprehensive.

---

## 5. Suggested sequencing

**Week 1 (quick wins, ~1 day of work total):**
S1 chmod fix · S2 CDN pin · S4 URL allowlist · D1/D2 dep removals · D3 artifact untracking · R1/R2 versions.json + CI guard · M1 clipboard util.

**Weeks 2–4:**
S3 ToolParamValidator across high-risk tools · top swallowed-error hotspots (SchemaMigrator, ToolCallTraceService) · result-shape standardization · storage-root centralization.

**Opportunistic (when next touching the area):**
HybridStorageAdapter/ChatSettingsRenderer splits · message-type merge (with Canonical Message Pipeline Phase 3) · adapter dedup + test template rollout · `no-explicit-any` to error · `vault.process()` migration.
