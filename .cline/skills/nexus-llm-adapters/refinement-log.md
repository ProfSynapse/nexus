# Refinement log

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
