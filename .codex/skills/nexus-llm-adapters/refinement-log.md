# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

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
