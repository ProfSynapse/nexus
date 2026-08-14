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
