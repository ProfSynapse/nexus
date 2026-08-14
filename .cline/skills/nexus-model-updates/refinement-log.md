# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

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
