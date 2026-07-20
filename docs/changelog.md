# Nexus Changelog

## July 2026

**v5.15.0** — Local CLI bridge for shell agents (`nexus`)

**Drive your vault from the shell — no MCP config**
- New **Local CLI** bridge: install a machine-global `nexus` command from **Settings → Get started → External agents** so shell-based coding agents (Claude Code, Cursor, Codex) can discover and run your vault's tools directly, with no `connector.js` / MCP server entry to configure. It speaks the same two-tool protocol over the same local socket the MCP connector uses; the plugin server is unchanged. Everything installs outside your vault and is fully reversible. See the [Nexus CLI guide](../guide/nexus-cli.md).
- A provider picker wires the CLI into the agents you choose — a Claude Code skill, a Cursor skill, and/or a Codex `AGENTS.md` pointer — defaulting to whatever it detects on your machine.
- The **Get started → MCP integration** path is renamed **External agents** (MCP clients + CLI coding agents).

**Vault-path confinement (security hardening)**
- Caller-supplied paths for every write tool now pass through a single fused confinement resolver that rejects directory traversal (`..`), absolute, and home-expansion paths — closing a hole where `content write` / `storage createFolder` could escape the vault. An eslint architecture guard prevents new direct-mutation call sites from bypassing it.
- **Windows hardening:** trailing-dot/space path segments (which Windows collapses to `..` at the syscall layer) are now rejected before they can escape; reserved device names (`CON`/`NUL`/`COM1`…), NTFS alternate-data-stream (`:`) paths, and control characters are rejected; and untrusted writes into executable-content directories (the Obsidian config folder, `.git`) are blocked to prevent config/hook code execution.

**Local CLI installer & socket hardening**
- The installer no longer overwrites (or, on uninstall, deletes) a pre-existing `nexus` command from another tool. The CLI verifies socket ownership before connecting, and the plugin's local socket is created owner-only with no permission-window race. On Windows the provider picker now reflects wired agents correctly and refreshes stale skill copies after an update.
- On Windows, **Install CLI** now adds `%LOCALAPPDATA%\nexus` to the current user's PATH automatically. Uninstall removes the entry only when Nexus originally added it, and the status display now distinguishes a present shim from a command that is actually resolvable on PATH.
- `nexus vaults` now discovers open Windows vaults through the local named-pipe namespace. This replaces the broken Node filesystem enumeration, which always returned `ENOTDIR`; `--vault <name>` remains available when local PowerShell policy blocks enumeration.
- Windows provider-skill copies now carry an ownership marker. Install, refresh, and uninstall preserve any unmarked same-named skill directory; successful uninstall also removes the PATH marker and remaining CLI payload instead of leaving a partial installation behind.
- Installation now requires a reachable Node.js 18+ runtime and reports when another `nexus` command takes precedence on PATH. JSON-RPC responses are shape-checked before use so valid non-object JSON cannot crash the CLI.
- `nexus use` now has a structured, cross-shell form: put context flags before `--` and the tool command after it. This preserves multiword PowerShell values without nested quoting; fragmented legacy commands now fail with an actionable correction, and `--dry-run` shows the reconstructed request without connecting or executing. After the initial user-approved installation, an updated desktop plugin now refreshes the already-installed Nexus-owned CLI and agent guidance automatically on load.

**Storage cutover fix**
- Once vault-root migration is verified (or no migration is needed), startup no longer merges legacy flat JSONL roots into normal reads. This prevents deleted legacy files and cloud-sync placeholders from being reopened after cutover; legacy roots remain enabled only while migration is pending or failed.

**v5.14.2** — Clearer MCP integration setup

- Reworked **Settings → Get started → MCP integration** so the `connector.js` bridge file is explained up front and the one-click buttons ("Connect Claude Desktop" / "Connect Codex") clearly generate it and wire it into the agent config for you.
- After connecting, a confirmation card now shows what was created (the connector file + config entry) and the restart step; revisits collapse to a compact connected state.
- Manual setup is now a collapsible with numbered steps — create the connector first, then add the config, then restart — so the connector file can't be skipped. Added an "Other agents" section (Cursor, Cline, Gemini CLI, Copilot…) linking to the full setup guide.

**v5.14.0** — Mistral OCR (native) + PDF image extraction

**PDF OCR now returns the full document** (fixes silent truncation)
- The "Mistral OCR" ingestion option (via OpenRouter) was reading the carrier model's chat completion instead of the OCR result, so PDFs came back paraphrased and truncated — as if a model had been handed the file and asked to rewrite it. OCR text is now read from the file-parser annotations, so you get the complete, faithful document.

**Native Mistral OCR**
- New OCR option that calls Mistral's OCR API (`api.mistral.ai/v1/ocr`) directly — no carrier model in the loop, per-page markdown, and exact image correlation. Enable the **Mistral** provider with an API key and pick **Mistral OCR (native)** as the OCR model. The OpenRouter route remains available as **Mistral OCR (via OpenRouter)**.

**Embedded images are extracted**
- OCR now saves images embedded in PDFs into a per-note asset folder (e.g. `report.pdf` → `report/img-0.jpeg`) and rewrites the OCR's image references into inline Obsidian `![[embed]]` links. The folder is namespaced per source file, so images from different PDFs never collide, and re-ingesting overwrites cleanly.

## June 2026

**v5.13.2** — Claude Sonnet 5

- Added **Claude Sonnet 5** (`claude-sonnet-5`) to the Anthropic, OpenRouter, and Requesty providers — 1M context, 128K max output, vision + tools + streaming + adaptive thinking. Pick it from the model dropdown for any of those three providers.

**v5.13.1** — Lint/store-compliance fixes

- Removed inline `eslint-disable` comments for `obsidianmd/ui/sentence-case` (rejected by the Obsidian community-store scanner) from the LM Studio / Ollama provider modals, handling the casing via the project acronym allowlist instead. No user-visible behavior change beyond one reworded Ollama help string.

**v5.13.0** — Local models that think, call tools, and stream reliably

**Local models can now drive tools (Ollama)** (PR #281)
- The Ollama provider previously assumed the local API couldn't do function calling — so local models couldn't be used for agentic chats. It now sends tool schemas, parses native `tool_calls`, and supports JSON/structured output, matching the LM Studio adapter. A capable local model can now actually use Nexus's tools.
- **Model discovery**: Nexus now lists every model you have installed in Ollama (via `/api/tags`) instead of only the single model you'd configured.

**Local models show their thinking** (PR #283)
- Reasoning-capable local models (LM Studio + Ollama) now stream their thinking live into a collapsible **Thinking** block in chat, persisted with the message and visible in the tool-inspection view — the same way cloud reasoning models already worked.

**Local streaming no longer goes blank** (PR #283)
- Fixed the blank-output / "stuck in reasoning" / reload-every-turn failures on LM Studio. Fatal errors that LM Studio delivers as an in-stream frame over HTTP 200 (e.g. a speculative-decoding rejection on batched-MLX models) were silently swallowed, leaving an empty bubble. Nexus now surfaces those errors and, when a draft/speculative model is rejected, automatically retries without it so the chat still produces output. The model-load path also stops needlessly reloading the model on every turn.

**Content edits tolerate punctuation drift** (PR #282)
- `content replace` (and the `replace` prompt action) matched anchors with limited normalization, so an anchor copied verbatim from a note could still fail to match over curly vs. straight quotes, dash variants, invisible/zero-width characters, or trailing whitespace. Matching now folds all of these (comparison only — your file bytes and replacement text are written verbatim). On a near miss, the closest line and a narrow re-read range are suggested instead of a generic "not found".

**Chat keeps you posted while tools run** (PRs #279, #280)
- A "still working" ticker now appears during the silent gaps of a streaming turn (e.g. while tools execute or when a local model goes straight to a tool call with no text), rendered inside the assistant bubble so it stays attached to the message and survives mid-stream re-renders.

**v5.12.2** — Query your notes with SQL, Antigravity provider, new image model

**Notes query index (new)** (PR #274)
- **Query your vault's notes and frontmatter like a database** — a new read-only `search query-notes` tool exposes every markdown file as queryable SQL rows (path, folder, title, tags, links, frontmatter, dates, size). Filter, aggregate, and sort across your whole vault with plain SQL — no separate query language to learn.
- Frontmatter properties are individually indexed, so filtering on arbitrary fields (e.g. `status`, `due`, `rating`) is fast even on large vaults.
- The index is built in the background at startup and kept fresh as you edit — your notes stay the source of truth, nothing is duplicated or re-indexed on disk. Verified on a 15,773-note vault; degrades gracefully above 250k notes (50k on mobile).

**Antigravity (`agy`) replaces the Gemini CLI provider** (PR #278)
- The provider formerly backed by the deprecated `gemini` CLI now runs on Google's **Antigravity** CLI (`agy`). It's relabeled **Antigravity CLI / Google (Antigravity)** in the model pickers; your existing settings carry over unchanged.
- This runtime is **text-completion only** — it does not support tool/function calling. Nexus now shows a settings notice and a runtime warning if you point a tool-using flow at it, so you won't get silent no-ops. Pick a tool-capable provider for agentic chats.
- Models are presented as two base models (Gemini 3.5 Flash, Gemini 3.1 Pro) with the existing effort slider choosing the thinking level — no more separate high/medium/low model entries.

**New model**
- **GPT-5.4 Image 2** is now available as an image model through **OpenRouter** (PR #177). Select it from the image-model picker.

**Fixes**
- **Task board / workspace counts were undercounting** on large workspaces (PR #275, #272): boards and workspace summaries computed their counts from only the first 200 tasks while the total showed the real number, so workspaces with more than 200 tasks (or lots of archived-project tasks) displayed wrong breakdowns. Both now read every page. Archived-project tasks no longer crowd out visible ones.
- **Stuck chat spinner cleared** (PR #276): an assistant reply that finished empty, errored before the first token, or hit the safety net could leave the loading spinner spinning forever. It now always clears.
- **Hung CLI providers now time out** (PR #276): a CLI runtime that streamed progress but never exited could hang a chat indefinitely. An idle watchdog (default 120s, re-armed on every chunk so long legitimate runs are never cut) now ends stalled runs cleanly.
- **Single wikilink no longer corrupted on set-property** (PR #273): passing a lone `[[Note]]` to a CLI array/property slot was eating a bracket pair and writing `[Note]`. Single values (including wikilinks) are now preserved verbatim; multi-item arrays still unwrap correctly.

**Under the hood**
- The `useTools` MCP call now enforces the context contract it always documented: `memory` and `goal` are required (an empty or placeholder value returns a clear steering error instead of silently proceeding); `workspaceId`/`sessionId` still default silently and `constraints` stays optional (PR #270). Agent tool-use guidance was also refined for better discovery → read → act behavior.

**v5.12.1** — New models + provider cleanup

**New models**
- **GLM 5.2** and **Kimi K2.7 Code** are now available through both **OpenRouter** and **Requesty**. Slugs and pricing were verified live and all four entries pass the provider smoke test.

**Model list cleanup**
- Removed a batch of superseded older models across providers to keep the model pickers current: Claude 4.5 Opus/Sonnet, Gemini 2.5 and Gemini 3.0 Preview, the GPT-5 / GPT-5.1 generation, and Groq's Llama 3.x + Gemma 2 models.
- The Google and Groq provider defaults moved to current models (`gemini-3.1-pro-preview` and `llama-4-maverick`, respectively). If you had one of the removed models selected, pick a current one from the dropdown.

**Fix**
- Fixed a build-breaking parse error introduced in v5.12.0 (#268): an unescaped backtick in the agent CLI-guidance prompt template.

**v5.12.0** — Adaptive Search: semantic search that learns from you, on-device

**Adaptive Search (new)** (PR #265)
- **Search that learns from which notes you actually open** — when you run a semantic search and then open one of the results, Nexus treats that as a small signal of what was useful, and gradually tunes how *future searches* are interpreted to fit your vault. It tunes the query, never your notes — nothing is re-indexed.
- **It can't make your search worse.** Every so often, while idle, Nexus runs a short "dream" consolidation: it mines recent search-then-open history, trains a few candidate tunings, tests each against held-out searches, and adopts the winner *only if it measurably beats* what you already have. Otherwise it changes nothing. Until something is provably learned, search behaves exactly as before — zero change on day one — and any adopted tuning is fully reversible.
- **Fully local and private.** Training runs entirely on-device against your own usage. No queries, behavior, or notes ever leave your machine.
- **On by default**, desktop-only — it rides on the existing local embedding model from Semantic search. Opt out with `embeddings.retrievalLearning: false`. Trigger a pass yourself anytime via the command palette: **"Consolidate retrieval memory (dream now)."** You'll get a brief notice only when an improvement is actually adopted.
- Guards against filter bubbles on purpose: it learns most from the searches it got *wrong*, rejects tunings that narrow your results, and keeps occasional wildcard results so new connections still surface. See the [Adaptive Search guide](../guide/adaptive-search.md).

**Task Board** (PR #267)
- **Delete a task directly from the board** — each card now has a delete icon next to edit, with a confirmation prompt.
- **Fixed the board showing "No tasks" on a cold start** — it now waits for the local cache to finish hydrating before rendering, instead of briefly appearing empty.

**Under the hood**
- The MCP agent is now nudged to batch multiple known file reads into a single parallel call, reducing round-trips during multi-file operations (PR #266). Agent-facing guidance only — no behavior change for your data.

**v5.11.2** — Security hardening, secure API key storage, model catalog refresh

**Security & privacy** (plugin audit, PRs #250–#256)
- **Opt-in secure API key storage** (PR #254) — a new "Store API keys in secure storage" toggle in the Providers tab moves LLM API keys, OAuth refresh tokens, and app credentials out of the synced `data.json` and into Obsidian's device-local `app.secretStorage` (requires Obsidian 1.11.4+; off by default — keys must be re-entered once per device when enabled).
- MCP Unix socket is now `0600` instead of world-writable; WebLLM CDN imports pinned to `@0.2.80`; web tools reject non-`http(s)` URLs (blocks `file://` reads from LLM-supplied links) (PR #255).
- Runtime validation for LLM-supplied tool arguments — malformed `createTask` input now returns a clean error instead of persisting bad data (PR #252).
- Silent JSON-parse failures in the storage layer are now logged with repository/column/row context (PR #256).
- Removed unused dependencies (`winston`, `uuid`, `tough-cookie`, npm copies of CDN-loaded WebLLM/transformers): 854 → 746 packages, 0 vulnerabilities (PR #251).

**Models** (PR #258)
- **Claude Fable 5** added to Anthropic, OpenRouter, and Requesty.
- Requesty catalog refreshed (GPT-5.5/5.4 family, Gemini 3.5/3.1/2.5, Claude 4.x/Fable 5); default model is now `anthropic/claude-sonnet-4-6`. Live-smoke verified, including a post-merge slug fix: Gemini 3.5 Flash on Requesty is `vertex/gemini-3.5-flash`.

**Fixes**
- `updateSession` no longer drops `startTime`; `updateMessage` now validates its conversation id instead of silently applying cross-conversation (PR #264).
- Reopening a done task clears its stale `completedAt` timestamp.
- Release workflow now fails on tag/manifest/package/versions.json mismatch; `versions.json` backfilled (PR #255).

**Internal**
- LLM adapter deduplication with 83 characterization tests pinning provider behavior (PRs #253, #257); `HybridStorageAdapter` split into assembly + maintenance services, surfacing the two fixes above (PRs #260–#263).

**v5.11.1** — Plugin review & audit compliance fixes.

**v5.11.0** — Live voice + read-aloud
- **Live voice chat**: OpenAI realtime (WebRTC) and Google Gemini live voice support, with transcripts appended to chat and prior-context priming (PRs #243, #248, #249).
- **Read aloud**: unified save + embed audio UX; voice audio settings (PRs #241, #245).
- Video generation artifact jobs (PR #242); short task refs (PR #239); slimmer YAML frontmatter bundle (PR #246); removed unused HTTP MCP transport (PR #247); security dep updates (MCP SDK 1.29.0).

**v5.10.0** — Skills & Data Analysis Apps + Workspaces tab redesign

**New Apps** (opt-in via Settings → Apps)
- **Skills Protocol** (PRs #228, #233) — author, index, and load agent Skills from your vault. Discovery + SQLite v13 index, full create/update/archive lifecycle (hard delete is UI-only), an automatic sync watcher, recursive `loadSkill` structure, and a Settings → Apps management UI. Vault-local only — never reaches OS-home provider folders. Hardened by a 3-auditor pre-merge pass (path-traversal/destructive-write fixes wired at every write/copy/remove boundary).
- **Data Analysis** (PR #229, desktop-only) — `runPython` runs pandas against vault CSV/Excel data in a sandboxed Pyodide worker, plus lossless `.xlsx` round-trip: workbooks project into editable CSVs and write back **automatically** (debounced vault watcher), preserving formulas/charts/images/pivots byte-for-byte via the vendored `hucre` engine. Mirror and write-back are fully automatic — the app exposes just `runPython` + `listCapabilities` (PRs #232, #234).

**Workspaces tab redesign — Wave 3 complete** (PRs #223, #226, #235)
- Redesigned Projects list, Project detail, and a new per-task **Task detail** page with Dependencies (Depends-on / Blocks) and Linked-notes sections.
- New Workflow editor and File picker ported to the shared `BoxedSection` shell.
- Mobile layout pass: responsive `@media (max-width:480px)` breakpoint, sticky-header degradation fallback, and WCAG tap-target sizing.

**Smarter AI context**
- Task linked-notes are now **readable** by the AI across `listTasks`, `queryTasks`, and `loadWorkspace`, with a documented `input`/`output`/`reference` link taxonomy and link-type assignment at task creation (PR #236).
- Workspace recent activity is now grouped by session and carries the memory/goal/constraints captured with each trace — the model sees *why*, not just *what* (PR #227).

**Integrations & infrastructure**
- Codex MCP setup added to the integration screen (PR #225).
- New `App.onload()` lifecycle hook so apps start background work only when genuinely loaded + enabled (PR #230).
- Connector now reuses the shared agent registry instead of double-initializing — fixes duplicate file watchers / double spreadsheet write-back (PR #231).

> **Note**: The Skills and Data Analysis apps are opt-in and dormant until enabled in Settings → Apps. Both are verified by unit tests + build; live in-Obsidian smoke-testing is ongoing.

## May 2026

**v5.9.0** — Pattern-anchored `content replace` (BREAKING)

**Pattern-anchored replace** (lockstep migration: `content replace` + `executePrompts.replace`)
- **BREAKING**: `content replace` schema replaces the 5-field shape (`path`, `oldContent`, `newContent`, `startLine`, `endLine`) with a 4-field shape (`path`, `start`, `end`, `content`). No backwards-compat shim — old payloads return a clean validation error so the model can self-correct on the next call.
- `start` and `end` are text anchors matched against whole lines in the file. Multi-line anchors join lines with `\n`. Both anchors must match exactly one location each; ambiguity returns an error that lists the matching line numbers and asks the model to extend the anchor.
- `content` replaces the inclusive range from `start` through `end`. Empty `content` deletes the range.
- Eliminates the ~10K-token `oldContent` fingerprint for large ranges and survives sequential edits without re-reading: anchors are content-based, so prior edits that shift line numbers do not invalidate them.
- `executePrompts.replace` action migrates in the same release: schema is `start` + `end` + `content`, mirroring the agent tool. The `position` deprecated alias and the line-range mode are both removed.
- NFKC + CRLF normalization (PR #183/#184/#187 intent) preserved on the new anchor-compare path — anchors authored in a different Unicode form than the file bytes still match.
- Schema descriptions updated end-to-end; no source code, JSDoc, or LLM-facing description still references `oldContent`/`newContent`/`startLine`/`endLine` on the replace path.

## April 2026

**Apr 28**: v5.8.6 — Content safety, GPT-5.5 support, Windows Claude Code auth

**Content safety and replacement matching** (PRs #183, #184, #187)
- `content replace` now compares `oldContent` with NFC/NFKC tolerance so visually identical accented or compatibility-normalized text can be matched without forcing overwrite.
- Replace still writes only the requested `newContent`; untouched file bytes are preserved.
- Leading Obsidian frontmatter is validated before content write/create/overwrite; malformed or non-mapping YAML is rejected without rewriting valid bytes.
- Regression tests now protect against editor/tool normalization collapsing NFD fixtures into tautologies.

**Model/provider updates** (PR #188)
- Added GPT-5.5 and GPT-5.5 Pro to OpenAI and OpenRouter model registries.
- Added GPT-5.5 to Codex defaults and adapter fallbacks.
- Added a reusable live provider/model smoke test for future model updates.

**Windows CLI auth fix** (PR #189)
- Claude Code auth detection now prefers `.cmd`/`.bat` npm wrappers on Windows.
- `%APPDATA%\npm` is included in common CLI discovery with wrapper-first ordering.
- Claude headless spawning now uses the shared wrapper-aware process path.

**Apr 20**: v5.8.2 — ToolManager content alignment + repo line-ending normalization

**ToolManager content alignment** (PR #170)
- CLI-first MCP contract finalized: `useTools`/`getTools` now accept only top-level `tool` string + top-level context fields; legacy nested `{context, calls}` and `{request}` arrays now rejected with a clear error message
- CLI parser decodes `\uXXXX` escapes inside quoted strings (e.g., `"\u2014"` → `—`); double-escaped `\\u2014` kept literal
- `executePrompts` actions aligned with modern `insert`/`replace`/`write` contract: `replace` takes `oldContent` + `startLine` + `endLine` for line-range edits; `position` still accepted but deprecated (normalized to startLine/endLine); `append`/`prepend` route to `insert`
- Behavioral tightening: `position < 1` now rejected (was `< 0`)
- 10 new tests in `ExecutePromptsActionAlignment.test.ts`; existing ToolManager/ExecutePrompts suites updated

**Line-ending normalization** (PR #169)
- Added `.gitattributes` establishing LF as canonical across the repo
- Renormalized all tracked text files to LF (whitespace-only, no behavior change)
- `.codex-temp/` and `.vscode/` added to `.gitignore`

**Apr 8**: v5.7.0 — Plugin-Scoped Storage Migration, Mobile Support, Major Refactors

> **Note**: Mobile support is experimental and may have bugs.

**Plugin-Scoped Storage Migration** (commit 52185ae9)
- Storage moved from `.nexus/` to `.obsidian/plugins/<plugin-folder>/data/` — enables Obsidian Sync across devices
- Automatic migration on first launch: copies JSONL data from `.nexus/` to plugin data dir; `.nexus/` kept as read-only fallback, never deleted
- JSONLWriter supports multiple read roots for cross-device sync discovery
- "Nexus: Refresh synced data" command for mobile users whose vault syncs after init
- Two-stage migration with cache.db path routing (commit 5a2bd087)
- Race condition fix, migration perf improvements, conversation delete sync (commit e088e513)

**Mobile Support (Experimental)** (PRs #102, #103, #111)
- PR #102: Fixed crash-on-launch on iOS/Android — Node.js built-ins don't exist on Obsidian mobile
- Created `desktopRequire()` utility at `src/utils/desktopRequire.ts` for lazy module loading
- Converted 15 files from top-level imports to dynamic `import()` / lazy `require()`
- Replaced Node.js `EventEmitter` with Obsidian's cross-platform `Events` class
- PR #103: Removed `node:stream` import from mobile streaming fallback
- PR #111: Fixed CORS error when loading Node.js modules in Electron renderer
- Desktop-only features (OAuth, CLI, MCP transports, ingestion, composer, web tools, semantic search) gracefully skip on mobile
- Native chat works on mobile; MCP, local providers, and semantic search remain desktop-only

**Major Refactors** (all files brought below 600-line threshold)
- PR #119: ChatView (1120+ lines) split into 4 coordinators: ChatSessionCoordinator, ChatSendCoordinator, ChatBranchViewCoordinator, ChatSubagentIntegration
- PR #113: SQLiteCacheManager split into 6 focused collaborators
- PR #112: ModelAgentManager split into 5 collaborators
- PR #117: TaskBoardView split into data/filter/grouping/edit/sync/renderer collaborators (1008 → 453 lines)
- PR #115: MessageBubble split with branch/streaming/image helpers
- All refactors include unit coverage; public APIs preserved

**Fixes**
- PR #107: Removed context guard that blocked workspace selection in chat settings
- PR #114: Fixed type errors in WorkflowRunService and ModelAgentManager
- PR #118: Fixed SQLite WASM alias resolution in production builds
- Task board page scrolling restored (commit b1ebd58c)
- Embedding init now awaits storage adapter ready (commit 88a0cf49)

**Provider Updates** (PR #119)
- Perplexity adapter reworked with updated model support and pricing
- HybridStorageAdapter conversation list fixes
- ToolContinuationService refactor with ToolSchemaSupport extraction

**Apr 6**: v5.6.9 — Conversation list pagination + search (PR #99)
- "Load More" pagination for conversation sidebar with true database OFFSET/LIMIT
- FTS title search in sidebar for filtering conversations
- 63 new tests

**Apr 6**: v5.6.8 — Chat UI bug fixes (PR #98)
- 13 chat UI fixes from PR #97 audit: click-blocking invisible pill, text not selectable, branch copy returning wrong content, input auto-resize, tool accordion, and more
- Dead code removal

**Apr 5**: v5.6.7 — Multi-provider transcription + task board fixes (PRs #95, #96)
- Shared `TranscriptionService` layer with 5 providers / 7 models: OpenAI (Whisper, GPT-4o Transcribe), Groq, Mistral (Voxtral), Deepgram, AssemblyAI
- Task board fixes #92–#94

**Apr 2**: v5.6.6 — CustomPromptStorageService dual-write fix (PR #89, issue #88)
- Removed early returns that skipped `data.json` write after SQLite ops, preventing prompt loss on restart

**Apr 1**: v5.6.5 — Plugin store compliance (PR #87)
- Resolved all ~190 obsidian-releases bot lint violations for plugin store submission

**Apr 1**: v5.6.4 — Type safety + linting (PR #86)
- `any` → `unknown` type migration across codebase
- ESLint v9 upgrade + obsidianmd community linter integration

## March 2026

**Mar 29**: v5.6.3 — DOCX, PPTX, XLSX ingestion support

**Mar 29**: v5.6.2 — Vault ingestion modes, PDF.js fix

**Mar 29**: v5.6.1 — Ingestion multi-provider, app UX fixes, Mistral multi-turn
- **Ingestion**: `IngestModelCatalog` + `IngestCapabilityService` — explicit catalog of OCR/transcription models; UI now shows provider+model dropdowns; supports OpenAI (Whisper, GPT-4o Transcribe), Groq (Whisper), Google Gemini multimodal audio, OpenRouter (Mistral OCR, Gemini); `enableIngestion` toggle in settings
- **App UX**: `AppManager` refactored — config is source of truth; apps install as disabled (credentials first); `BaseAppAgent.supportsValidation()` + `getValidationActionLabel()`; `AppsTab` shows real manifest descriptions
- **Mistral**: passes `conversationHistory` for multi-turn; `supportsImages: true`

**Mar 29**: Web Tools Agent ✅ (PR #82)
- New `WebToolsAgent` with 5 desktop-only tools: `openWebpage`, `capturePagePdf`, `capturePagePng`, `captureToMarkdown`, `extractLinks`
- Electron BrowserWindow (`webViewer.ts`) renders pages headlessly; captures via `webContents.printToPDF()`, `capturePage()`, and DOM extraction
- `captureToMarkdown`: strips boilerplate (nav/header/footer/ads), converts HTML→Markdown via Turndown
- `extractLinks`: full link inventory with URL, text, and type (internal/external/anchor/resource)
- Desktop-only (`Platform.isDesktop` guard) — requires Electron APIs

**Mar 29**: Nexus Ingester ✅ (PR #83)
- New `IngestManagerAgent` with `ingest` + `listCapabilities` tools
- Drag PDF/audio files onto chat → confirmation modal → extraction/transcription → `.md` note alongside original
- PDF modes: text (pdfjs-dist `getTextContent()`) + vision (pdfjs-dist page render → OCR via vision API); default 20-page limit
- Audio: Whisper API via OpenAI + Groq only (Ollama/LM Studio excluded — no endpoint; Google deferred to v2)
- pdfjs-dist bundled via LoopbackPort (no worker file needed); `decodeAudioData` try-catch fallback + >25MB size guard
- VisionMessageFormatter: 4 provider families (OpenAI, Anthropic, Google, Ollama format)
- UI: IngestDropOverlay, IngestProgressBanner, IngestConfirmModal, IngestEventBinder + DefaultsTab settings
- 175 tests across 9 test files
- Plan: `docs/plans/nexus-ingester-plan.md`

**Mar 29**: Composer App ✅ (PR #81)
- New `ComposerAgent` with `compose` + `listFormats` tools following BaseAppAgent pattern
- IFormatComposer strategy pattern: markdown concat, PDF merge (pdf-lib 1.17.1), audio concat/mix (OfflineAudioContext)
- Audio output: WAV (native PCM), WebM/Opus (MediaRecorder), MP3 (wasm-media-encoders 0.7.0, MIT)
- Audio mixing: multi-track with per-track volume, offset, fadeIn/fadeOut via Web Audio API
- Security: isValidPath() path traversal prevention, aggregate file size limit (default 200MB), atomic overwrite, bounds validation
- 87 tests (7 files); pdf-lib + wasm-media-encoders pinned to exact versions

**Mar 25**: v5.5.0 — Task Board, Compaction Frontier, Tool Refactors, Provider Updates ✅ (PRs #65–72)
- **CLI providers stdin** (PR #65): Claude Code + Gemini CLI now pass prompts via stdin; Windows argv safety guard (24K limit)
- **SystemPromptBuilder refactor** (PR #66): Cleaner composition pipeline, `CompactionFrontierRecord` injection, new guide
- **Task Board UI** (PR #67): Native Obsidian kanban view (todo/in-progress/done), `openTasks` agent tool, `TaskBoardEvents` pub/sub for live refresh
- **ContextBudgetService** (PR #72): Unified context window budget tracking + compaction thresholds across all providers
- **CompactionFrontierService** (PR #68): Bounded stack of compacted context records; meta-compaction; transcript recovery; pre-send spinner in ChatInput
- **Tool display refactor** (PR #69): `toolDisplayNormalizer` + `toolDisplayFormatter` extracted from `ProgressiveToolAccordion`; structured `ToolDisplayGroup`/`ToolDisplayStep` types
- **Tool execution refactor** (PR #70): `ToolBatchExecutionService` extracted from `useTools` (430→122 lines); enriched `DirectToolExecutor` event shape
- **Provider updates** (PR #71): GPT-5.4 Mini + Nano, GitHub Copilot live model discovery, `StreamingOrchestrator` responseId persistence, `ModelDropdownRenderer` fallback fix

**Mar 23**: Claude Code Integration + Replace/Insert Tools ✅ (v5.4.0, PRs #57, #58)
- Claude Code as native chat provider: uses local Claude CLI subscription login (no API key needed)
- New `anthropic-claude-code` adapter with headless Claude Code runner and binary discovery
- Claude Code models (Haiku 4.5, Sonnet 4.6, Opus 4.6) labeled "(Claude Code)" in model dropdown
- Tool call traces and reasoning surfaced in existing chat accordions
- Replaced unified `update` tool with `replace` + `insert` tools (inspired by community PR #56)
- `replace`: validates `oldContent` at startLine/endLine, sliding-window search on mismatch
- `insert`: positional insert (N), prepend (1), append (-1)

**Mar 13**: Settings UI Redesign ✅ (PR #42)
- CSS spacing token system: 7 `--space-*` tokens (4px base), replacing ~15 hardcoded values
- New `SearchableCardManager` component: composition wrapper with search/filter + group headers
- All 4 card tabs migrated (Workspaces, Providers, Apps, Prompts) + GetStartedTab
- BreadcrumbNav: chevron icon separators, CSS specificity fix for Obsidian button defaults
- Card hover: `box-shadow` → `background-color` transition (theme-aware)
- BackButton: `div` → `button` element (keyboard accessibility)
- `CardManagerConfig.onAdd`/`addButtonText` now optional
- WorkspacesTab decomposed: 1,611 → 855 lines + WorkspaceListRenderer + WorkspaceDetailRenderer
- 132 new tests across 6 files
- Plan: `docs/plans/settings-ui-redesign-plan.md`

**Mar 8**: SDK→HTTP Migration ✅ (commit 103a9e73)
- Removed provider SDKs (OpenAI, Anthropic, Google, Groq, Mistral) — direct HTTP via shared ProviderHttpClient
- Real-time streaming via Node.js https + `processNodeStream()` (replaces buffered requestUrl approach)
- New: `ProviderHttpClient.ts` (shared HTTP + streaming + HTTPS enforcement + retry), `BufferedSSEStreamProcessor.ts`
- Fixed: Google finish reason mapping, MALFORMED_FUNCTION_CALL error surfacing, OpenAI SSE multi-line parser, Anthropic stale betas field, Mistral param names, error body truncation (security)
- 796 tests (+34 new)
- UI: ChatInput tri-state button, MessageManager interrupt-before-send

**Mar 8**: v5.1.0 Release ✅
- SDK→HTTP migration: Removed all LLM provider SDKs, direct HTTP via `ProviderHttpClient` + Obsidian `requestUrl`
- Real streaming on desktop (Node.js https), buffered fallback on mobile
- TaskManager DI wiring fixed (was never registered in runtime init path)
- Deleted unused agent factory system (`ServiceFactory.ts`, -409 lines)
- Self-documenting TaskManager tool schemas (result objects fully defined)
- Wired TaskService into MemoryManager for loadWorkspace task summaries

**Mar 8**: TaskManager Agent ✅ (PR #37)
- New agent: workspace-scoped project/task management with DAG dependencies
- Data model: Workspace → Project → Task, with `dependsOn[]` DAG edges + `parentTaskId` subtask tree
- 10 tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote
- Services: TaskService (facade) + DAGService (pure computation: cycle detection, topological sort, next actions, blocked tasks)
- DB: 4 new tables (projects, tasks, task_dependencies, task_note_links), schema v8→v9, JSONL+SQLite hybrid
- Integration: auto-loads task summary via loadWorkspace, CacheableEntityType extended with 'project'/'task'
- 857 tests (236 new across 5 test files)
- Plan: `docs/plans/task-manager-agent-plan.md`, Architecture: `docs/architecture/task-manager-agent-architecture.md`

**Mar 4**: New Models + Bug Fixes ✅ (v4.4.5 → v4.4.6)
- Added Claude Sonnet 4.6, Gemini 3.1 Pro/Flash Lite, GPT-5.3 Chat/Codex; removed legacy Claude 4 Opus/Sonnet
- Fixed ConversationTitleModal focus trap, default temperature loading, prompt selector key, `syncWorkspacePrompt()` name vs id

## February 2026

**Feb 28**: Dynamic Image Model Defaults ✅ (v4.4.4)
- Image generation defaults now resolve from user settings instead of hardcoded values
- Priority chain: explicit param > user settings > first available provider/model > fallback
- `generateImage`: new `resolveDefaults()`, `getAvailableProviderNames()`, dynamic schema/errors
- `executeTypes`: provider optional + accepts openrouter, model widened to string

**Feb 26**: Dynamic Image Model Loading ✅ (v4.4.3)
- Image model dropdowns now load dynamically from adapters (removed hardcoded `IMAGE_MODELS`)
- `generateImage` tool schema builds model enum at runtime from configured providers

**Feb 26**: New Image Models + FLUX Validation Fix ✅ (v4.4.2)
- Added `gemini-3.1-flash-image-preview`: Google direct + OpenRouter, 512px-4K, 14 ref images
- Added `gpt-5-image` (OpenRouter only): GPT-5 with image generation, 400K context
- Fixed FLUX models (`flux-2-pro`, `flux-2-flex`) failing validation

**Feb 23**: Workspace Settings Display Fix ✅ (v4.4.1)
- Root cause: `renderWorkspacesTab()` passed stale `prefetchedWorkspaces` (populated before SQLite ready)
- Fix: pass `prefetchedWorkspaces: null` → WorkspacesTab always shows loading skeleton → awaits SQLite

**Feb 22**: Tool Call History Fix ✅ (v4.4.0)
- `MessageStreamHandler.ts` — post-loop safety net: forces `state=complete` + accumulated toolCalls
- `ConversationService.ts` — try-catch around `JSON.parse(tc.function.arguments)` in `convertToLegacyConversation`
- `MessageRepository.ts` — defensive try-catch in `rowToMessage()` for toolCallsJson/metadataJson/alternativesJson

**Feb 22**: TypeScript Build Fix ✅ (PR #31)
- `IPCTransportManager.ts` — changed socket param from `NodeJS.ReadWriteStream` to `net.Socket`

**Feb 22**: OpenAI CORS Bypass + Validation Fixes ✅ (PR #29)
- `nodeFetch.ts` — Node.js `https.request()` passed as custom `fetch` to OpenAI SDK; bypasses CORS on `/v1/responses`
- 619 tests (adds 55 nodeFetch unit tests)

**Feb 22**: Provider OAuth Connect ✅ (PR #26 — v4.3.4)
- OpenAI Codex OAuth via ChatGPT: connect button, token refresh, model listing with `(ChatGPT)` suffix
- **Codex Responses API gotchas (CRITICAL)**:
  - No `previous_response_id` support — must use stateless full input array continuation
  - `delta` is plain string, not object — `typeof event.delta === 'string'` check required
  - CORS from `app://obsidian.md` — must use Node.js `require('https').request()` not `fetch()`
  - `for await` unreliable in Electron — use explicit `chunkQueue`/`chunkWaiter` event-listener queue
  - `instructions` field always required — cannot be conditional on conversationHistory
  - Model won't use tools without `tool_choice: "auto"` + explicit tool-use preamble in instructions

**Feb 21**: IPC Transport Fix ✅ (v4.3.2)
- Fixed `handleSocketConnection` never wiring socket `close`/`end` to `transport.close()`
- FD leak on failed `connect()` also fixed (socket destroyed on rejection)

**Feb 20**: New Model Definitions ✅ (PR #22 — v4.3.1)
- Added Claude Sonnet 4.6 (`claude-sonnet-4-6`): 200K ctx, 64K out, $3/$15/M
- Added Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`): 1M ctx, 65K out, $2/$12/M

**Feb 9**: Conversation Memory Search ✅ (PR #19 — merged)
- Semantic search across conversation turns and tool call traces via `searchMemory` tool
- Two modes: Discovery (workspace-scoped) and Scoped (session-filtered, N-turn window)
- QA pair model + ContentChunker (500-char/100-overlap) + sqlite-vec KNN + multi-signal reranking
- Real-time indexing via ConversationEmbeddingWatcher + background backfill
- 351 tests pass (205 new), all coverage thresholds met
- Plan: `docs/plans/conversation-memory-search-plan.md`

**Feb 5**: Startup Performance Fix ✅ (PR #15)
- Non-blocking startup ~200ms (75x improvement from ~15s)
- Root cause: deadlock between ChatView.onOpen() and onLayoutReady

**Feb 5**: Chat Stop/Retry/Branch Bug Fixes ✅ (PR #16)
- 12 bugs fixed across stop, retry, and branch navigation
- 142 unit tests across 7 new test files

**Feb 5**: Inline AI Editing Feature ✅ (PR #14)
- Right-click or hotkey to edit selected text via LLM
- State machine pattern, streaming preview, Jest test infrastructure (41 tests)

## January 2026

**Jan 24**: ExecutePrompts improvements (optional provider/model, reference images, CommandManager cleanup)
**Jan 12**: MCP integration settings fix (invalid config handling)
**Jan 4**: CanvasManager agent (4 tools), SQLite transaction fix, memory leak fixes (7), embeddings toggle

## December 2025

**Dec 22**: Subagent UI + architecture
**Dec 20**: Auto-compaction + dual models + WebLLM
**Dec 17**: Two-Tool Architecture (95% token reduction)
**Dec 16**: Local embeddings + dead code cleanup (~4,000 lines removed)
**Dec 9**: Mobile + branching persistence
**Dec 3**: SQLite + JSONL hybrid storage
