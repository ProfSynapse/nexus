# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

- 2026-08-14 | Dogfooded the skill fixing the four defects its own validator
  found. Four gaps surfaced. (a) `change-default.md` assumed the job was always
  "move a provider default"; repairing one drifted declaration would have been
  led into changing the registry export, which was already correct. (b) It said
  to update every test mentioning the old id — in practice most hits were
  fixtures that merely used the id and rewriting them would have been pure churn.
  (c) Nothing said a *fallback* registry's display names must describe the slug
  they carry, which was the actual shape of the Copilot rot: current names over
  old slugs. (d) A half-wired existing provider had no entry point; only the
  validator warning pointed anywhere. Separately, the first pass at the Copilot
  default fixed the dangling reference by picking an even older id — the skill
  had no guidance that "resolves" and "current" are two defects. | Added a "Which
  steps apply" branch and a "Choosing the incoming model" section to
  `change-default.md`, split step 6's grep results into assertions vs fixtures,
  added the name-must-match-slug rule to the fallback section of
  `registry-anatomy.md`, and widened `add-provider-registry.md` to cover
  repairing a half-wired provider. | Files: `protocols/change-default.md`,
  `protocols/add-provider-registry.md`, `references/registry-anatomy.md`.

- 2026-08-14 | improve-skill pass. The skill was one prose file with no
  progressive disclosure and no check, and — worst for a skill whose subject is a
  list of models — it carried model ids, prices, context windows, a YAML config
  to copy and a table of pass-rate baselines, all of which had already rotted.
  Its stated smoke-test token budget was wrong, its provider coverage was
  incomplete, and it hardcoded one machine's filesystem path. | Rewrote as a
  router plus four procedure protocols and three references; added
  `scripts/check_model_registry.py`, which discovers every provider, registry and
  id from the tree and checks entry shape, provider/directory agreement,
  unreachable duplicate ids, defaults pointing at nothing, adapter literals that
  drifted from the registry, half-wired aggregators and the shipped settings
  default; deleted every model id, price and baseline; re-verified every
  remaining claim against source and handed eval-harness content to
  `nexus-model-eval`. | Files: the whole skill.

- 2026-08-27 | Adding `z-ai/glm-5.3-flash` and `qwen/qwen3.8-flash` to the
  OpenRouter registry, the Qwen smoke run failed with an opaque
  `generation failed: Provider returned error` that looked like a bad id but was
  a 429 from Alibaba's saturated shared pool (the model had launched the day
  before); a direct curl exposed the error body and a retry with backoff
  passed. | Added a third impostor — upstream saturation on a just-launched
  gateway model, diagnose via direct curl, retry with backoff — and reworded
  verify-model's anti-pattern to not hardcode the impostor count. | Files:
  `references/smoke-harness.md`, `protocols/verify-model.md`.

- 2026-08-27 | Commenting out the Qwen3.8 Flash entry (held back for upstream
  reliability, per the user) made the gate report a phantom entry missing every
  field: the brace walker counted braces inside `//` comments. | Added
  `mask_line_comments()` in `check_model_registry.py` — blanks line comments
  (outside quotes) with spaces before parsing, preserving offsets so line
  numbers stay true. Commented-out entries are now a legitimate registry
  state. | Files: `scripts/check_model_registry.py`.
- 2026-08-27 | The anthropic API registry gained the Claude 5 family while the
  anthropic-claude-code twin sat at Sonnet 4.6 — nothing in the protocol pairs
  the two registries, so an API-side update leaves the CLI twin stale until a
  user notices missing models in the picker. Same exposure for
  openai / openai-codex. | Added step 6 ("Update the CLI twin registry") to
  add-model.md: a pairing table (API registry ↔ CLI twin ↔ the twin's own
  verification command) and the rule that touching either side means deciding,
  per model, whether the other side gets it too — verified through the twin's
  transport, cost 0 on the CLI side. | Files: `protocols/add-model.md`.
- 2026-09-02 | Adding Claude Fable 5.1: both gateway catalogs were
  egress-blocked from the remote session, and the Requesty registry's own
  header ("dashed upstream slugs") plus every Claude sibling pointed at
  `claude-fable-5-1`, while Requesty's listing (supplied by the user as a
  screenshot) publishes `anthropic/claude-fable-5.1`. A sibling's separator
  would have produced a confidently spelled 404. | Added two lookup rows to
  registry-anatomy: a sibling's separator is not evidence, and an unreachable
  catalog means asking the user for the listing page rather than stopping. |
  Files: `references/registry-anatomy.md`.
- 2026-09-02 | OpenRouter had split image generation onto a dedicated Image API
  ten weeks earlier and three of seven shipped image models were dead (the
  default's preview id retired; FLUX 404 on chat completions). Nothing in this
  skill covered image models: they live in adapter-local catalogs the gate
  cannot see, their enum is embedded in the committed tool catalogs, and the
  provider's own listing was wrong twice (a resolution advertised then rejected;
  a listed id with an empty endpoints array). | Added `protocols/add-image-model.md`
  — transport choice, the two catalog commands, copy-the-endpoint-parameters
  rule, catalog regeneration, and a mandatory live call with a mundane prompt —
  and a workflow row pointing at it. | Files: `protocols/add-image-model.md`,
  `SKILL.md`.
- 2026-09-02 | Live calls through the rewritten Gemini and OpenAI adapters found
  two silent overcharges the docs never state: Google accepts `imageSize:
  "512px"` and renders a 1K image (the enum is `"512"`), and OpenAI with no
  `size` chose 1536x1024 at `high` for gpt-image-1-mini, five times list.
  gpt-image-2 also rejects any dimension not divisible by 16. | Added three
  guideline bullets to `protocols/add-image-model.md`: read the wire enum and
  compare token counts across spellings, never let a token-priced provider pick
  size/quality, and the divisible-by-16 rule. | Files:
  `protocols/add-image-model.md`.

- 2026-09-08 | The paired subscription registry was described as CLI-backed, but its adapter uses OAuth HTTP; an old CLI rejected the requested model while the adapter independently failed on expired credentials. | Clarified transport-specific twin verification in protocols/add-model.md.

- 2026-09-08 | Live generation and reference-image edits returned distinct text and image input token counts. | Added modality-specific input pricing guidance to protocols/add-image-model.md; measured output-token prices for the new catalog entries. The full provider-wiring suite also caught first-entry fallback drift; documented preserving catalog order when defaults are unchanged.

- 2026-09-17 | Gemini 3.8 Live shipped as a `bidiGenerateContent`-only id: `generateContent` returns HTTP 400, so it cannot live in `GoogleModels.ts` or pass the smoke lane. Realtime voice models have their own catalog (`src/services/llm/types/RealtimeVoiceTypes.ts`, WebSocket session in `src/services/realtimeVoice/`) that this skill never mentioned, and the Extended Thinking variant closes the socket (1007) unless `thinkingConfig.thinkingLevel` (low/medium/high, not minimal) is in `setup`, while the base model closes it if the field is present. | Added `protocols/add-realtime-voice-model.md` (catalog location and ordering, the 1007-at-setup failure mode, `thinkingLevelFloor`, and the shipped-session smoke lane `tests/debug/realtime-voice-google-live-smoke.test.ts`) plus a workflow row in SKILL.md. | Files: `protocols/add-realtime-voice-model.md`, `SKILL.md`.

- 2026-09-18 | Told the user Gemini 3.8 Flash did not exist because the registry topped out at 3.7 — the registry is a snapshot and the protocol already says to source from the provider, but nothing said what to run. Google's `/v1beta/models` listing showed `gemini-3.8-flash` immediately (plus context window and max output); OpenRouter's `api/v1/models` gave the gateway price including `input_cache_read`. | Added `references/provider-listings.md` with the two listing commands and what each field maps to, and a step-1 bullet in `protocols/add-model.md` that the registry's absence is not evidence of the provider's absence. | Files: `protocols/add-model.md`, `references/provider-listings.md`.

- 2026-09-22 | Added Claude Opus 5.5 to the Anthropic registry and the Claude Code twin, and skipped OpenRouter because the OpenRouter registry here did not carry Opus 5. The user pointed out OpenRouter already served `anthropic/claude-opus-5.5`, and its listing confirmed the $0.20 cache-read rate, which departs from the 0.1× structure. Same failure as the 2026-09-18 entry, with the registry-as-snapshot mistake applied to gateways instead of the vendor. | Added a step-1 bullet in `protocols/add-model.md`: run the gateway listing on every vendor release, whatever the gateway registry holds for the predecessor. | Files: `protocols/add-model.md`.

- 2026-09-22 | Adding GPT-6 Sol and Luna: the OpenAI and Codex adapters dropped `temperature`/`top_p` for `model !== 'gpt-6-astra'` only, and a live probe showed Sol and Luna reject both with a 400 too. Step 5's routing grep only matched `includes`/`startsWith`, so it could not have found an exact-id guard, and it used `rg`, which is not installed on every dev machine. | Widened the step-5 pattern to exact-id equality and regex tests, switched it to `grep -E`, and added guidance to turn a one-id guard into a family predicate once a sibling needs it. | Files: `protocols/add-model.md`.
