# Refinement log

Append-only record of changes to this skill. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-19 | The skill treated one repo-root CLI file as authoritative, but releases now generate versioned CLI and MCP catalogs with compatibility aliases. | Updated refresh and consumer guidance around `schemas:release`, `schemas:check`, the manifest, both surfaces, and scratch exports. | `protocols/refresh-catalog.md`, `references/consumers.md`, `references/exporter-internals.md`.

## 2026-08-14 | improve-skill pass

**Observation.** The skill documented the exporter's default output path as the
answer, when that path is a gitignored scratch file no consumer reads; the file
the repo's tests validate against only gets written when `--output` names the
repo-root catalog. One example selector named an agent and a tool that both fail
to resolve (`web-tools capture-to-markdown`; the CLI alias strips the trailing
`Tools`, and the tool is `capture-markdown`). The sync advice pointed the wrong
way down the mirror. Nothing verified any of it.

**Change.** Rebuilt as a router over two protocols split on the only decision
that matters — scratch export vs. refreshing the committed catalog — with the
output path made explicit in the consequential one. Added
`references/consumers.md` (who reads which file, and why a stale catalog is
worse than a missing one) and `references/exporter-internals.md` (headless
boot, what it needs, failure messages). Added two checks:
`scripts/check_catalog.py` for the artifact and
`scripts/check_exporter_coverage.py` for the exporter's hand-written agent
roster.

**Found while writing the checks**, both pre-existing and reported rather than
fixed: `prompt sub` advertises two arguments whose flag kebab-cases to a bare
`--`, and two registered app agents are missing from the exporter's roster, so
their tools appear in no export.

**Files.** SKILL.md, protocols/, references/, scripts/, this log.
