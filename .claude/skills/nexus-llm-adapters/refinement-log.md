# Refinement log

- 2026-10-07 | Direct requests to an installed Ollama model verified the proposed generic text/tool contract before adapter implementation. | No guidance change; local-providers already calls for direct endpoint verification first. | Files: refinement-log.md.

- 2026-09-30 | A rejected Codex refresh token raised an auth error while Settings still showed Connected because the adapter never updated persisted OAuth state. | Added the symptom, mechanism, and source entry points to the lookup. | Files: `references/symptoms.md`.

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-24 | A 2026-08-21 entry below repointed this skill's validator command at
`.codex/skills` on the premise that the `.claude/skills` mirror had been removed.
The premise was false: `scripts/sync-agent-context.mjs` copies `.skills/` into all
three mirrors byte-for-byte with no path rewriting, so both mirrors exist and a
mirror-local path cannot survive a sync — the edit only produced drift. | Restored
the canonical `.claude/skills` path used by the rest of the skills (63 references
to 0). Edit `.skills/` and run `npm run sync:skills`; never edit a mirror. |
`protocols/self-refine.md`, `refinement-log.md`.

- 2026-08-21 | The terminal validator recipe combined a stale `/tmp`
  skill-crafter location with the removed `.claude/skills` project mirror. |
  Made installed skill-crafter resolution explicit and pointed validation at
  `.codex/skills/nexus-llm-adapters`. | Files: `protocols/self-refine.md`,
  `refinement-log.md`.

- 2026-08-21 | Full-tree review found that Google and Ollama synthesize
  response-local tool-call ids which were reused directly as durable operation
  ids, causing later calls at the same function/index to conflict or replay stale
  output. | Documented the response-local ID boundary, required turn/response
  scoping before receipts, and added the user-visible symptom. | Files:
  `references/streaming-contract.md`, `references/symptoms.md`,
  `refinement-log.md`.

- 2026-08-21 | The new provider driver/instance boundary made the adapter
  protocol's generic "trace wiring" step underspecify the now-mandatory
  lifecycle seam. | Updated the add-adapter procedure to require driver
  registration, compatibility-first dynamic imports, config validation,
  default-instance identity, and instance-owned cleanup. | Files:
  `protocols/add-adapter.md`, `refinement-log.md`.

- 2026-08-21 | The adapter procedures correctly separated provider response
  parsing from chat turn orchestration; the 13-adapter error-wiring audit found
  no gap, and no user correction was available. | No skill change. | Files:
  `refinement-log.md` only.

- 2026-08-21 | Anthropic response extraction was correct, but newer registered
  models used a request shape that was deprecated or rejected and some defaulted
  to omitted summaries. | Added the missing/empty-thinking symptom and a request-
  controls audit covering model-generation boundaries, visible summaries,
  incompatible sampling controls, and opaque continuation state. | Files:
  `references/symptoms.md`, `references/reasoning-rendering.md`.

- 2026-08-21 | LM Studio returned normal answer text while Nexus showed no
  Thinking block because the adapter recognized only `reasoning_content`, not
  the provider's newer `reasoning` alias. | Added the missing-thinking symptom
  and documented that reasoning field names vary across provider versions and
  models. | Files: `references/symptoms.md`, `references/reasoning-rendering.md`.

- 2026-08-15 | Researching adaptive Ollama context exposed a missing diagnostic:
  local model metadata can report a native/fallback window instead of the runtime
  allocation, causing both the context badge and compaction gate to fail; tuning
  variables may also belong to a shared server rather than the request. | Added a
  symptom row and a runtime-context/source-of-truth plus server-ownership section.
  | Files: `references/symptoms.md`, `references/local-providers.md`.

- 2026-08-14 | improve-skill pass. The skill was a single prose file: correct
  content, but nothing to execute, no progressive disclosure, and no check. |
  Restructured into a router plus four protocols and six references; added
  `scripts/check_stream_error_wiring.py` and wired it into the verify and debug
  protocols; re-verified every factual claim against the source tree and dropped
  or rephrased the ones that no longer held. | Files: the whole skill.

- 2026-08-27 | Grading Groq models exposed that GroqAdapter built requests from
  `prompt + systemPrompt` only and never read `options.conversationHistory` —
  every tool continuation was sent with no history, so any tool-using chat on
  Groq went silently blank after the first call (eval: 5% pass). Also
  `listModels()` hard-forced supportsThinking:false over the registry, and
  `getCapabilities()` claimed a stale 128k window. | Added `resolveMessages()`
  (OpenRouter's pattern: prefer conversationHistory, re-add the stripped system
  prompt) to both paths, dropped the thinking override, corrected capabilities;
  post-fix eval 97% (gpt-oss-120b) / 100% (qwen3.6-27b). Added the symptom row
  to `references/symptoms.md`. | Files: `src/services/llm/adapters/groq/GroqAdapter.ts`,
  `references/symptoms.md`.

- 2026-09-08 | A new reasoning model rejected normal sampling settings; request-body regression tests and live completion, streaming tool calls, and rejected-model checks exercised the documented workflow. Subscription live verification was blocked by stale credentials. | No procedure change.

- 2026-09-08 | Live generation and multipart reference-image edits passed for both new image models. | No procedure change.

- 2026-10-07 | Implemented a generic Chat Completions driver and exercised buffered generation, streaming, errors, cancellation, and tool-result continuation against Ollama plus the real Nexus loop in Obsidian. Existing verification protocol covered the failure classes found; no procedure change.

- 2026-10-08 | Malformed tool JSON recovery could not establish why the provider stopped because streaming collapsed its stop reason and the shared processor discarded normalized finish reasons. | Added response-diagnostic guidance and a symptom row: retain raw metadata, normalized completion reasons, each tool-round boundary, and received metadata before a later stream error. Live Anthropic verification was unavailable without credentials. | Files: `references/symptoms.md`, `references/streaming-contract.md`.

- 2026-10-08 | User feedback identified output and manual-thinking defaults that could truncate high-effort responses despite the selected model's larger allowance. | Documented inspecting both limits: required output caps should use the model allowance, optional caps should stay omitted, and elevated manual budgets should fit the effective cap. | File: `references/streaming-contract.md`.
- 2026-10-08 | Adding a model with typed thinking/text content exposed that parsing reasoning alone is insufficient: stored history and tool continuation must replay the full assistant content, and model-specific gateway builders need the model passed at every factory call. | Existing routing and preservation guidance covered the fix; no procedure change. | Files: Mistral and Requesty adapters, context builder/factory, provider message builder and tool continuation service; regression tests cover actual continuation and stored-history replay.
- 2026-10-08 | Independent release review found a reasoning toggle that relied on omission despite the provider enabling reasoning by default, cached responses that ignored effective reasoning settings, and stored tool history that inferred response boundaries from identical content. | Fixed explicit disable/request-cache behavior and recorded response boundaries for accurate replay. Existing guidance covered these contracts; no procedure change. | Files: Anthropic/Mistral/Requesty adapters, runtime reducer, context builder and regressions.

- 2026-10-09 | Thinking disclosure jitter after combining tool-round reasoning came from per-response auto-collapse and redraws inferring a different state; queued native toggle events also let tokens overwrite manual clicks. | Updated reasoning-rendering and symptom guidance to distinguish turn completion, reuse the disclosure, and capture reader choice before updates. | Files: references/reasoning-rendering.md, references/symptoms.md.

- 2026-10-09 | The cost counter only settled at turn completion and reused a single response usage snapshot; usage classes and native search fees exposed additional gaps. | Added streaming-contract guidance for cumulative snapshots versus response sums, separate context occupancy, and provider-specific token classes. Tests cover interim usage and usage surviving a later error. Live hosted-provider checks are unavailable without credentials.

- 2026-10-09 | Native web search requires server tool events to stay separate from client tool calls, citations to survive streaming, and full Anthropic response blocks to survive continuation and stored history. | Recorded explicit response boundaries rather than inferring them from visible text; bypassed local answer caching for search-enabled requests. Regression tests exercise the provider request and continuation paths. Existing preservation guidance applies; no protocol change.

## 2026-10-09 — Context handoff boundaries
- Observation: full compaction needs to exclude the old transcript while admitting future messages; retry slicing can remove its marker and restore oversized history.
- Change: documented prepare/commit and real-budget/boundary regression coverage in references/chat-plumbing.md.

## 2026-10-09 — Adversarial handoff follow-up
- Observation: green first-compaction tests missed boundary loss on frontier merge, backwards compaction after a handoff, and stale provider replay metadata during cross-provider retry.
- Change: added repeated-compaction and replay-replacement checks to references/chat-plumbing.md; regressions exercise actual metadata, filtering, and provider message construction.
