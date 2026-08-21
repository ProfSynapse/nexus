# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-21 | The harness graded tool calls and final prose but could not test
the user's requested Nexus-facing thinking behavior or a reasoning-bearing
tool continuation. | Documented the new thinking scenario semantics: grade
only production-stream-visible reasoning, require a tool round for
continuation coverage, and quarantine capability probes from leaderboards
where appropriate. | `references/scenario-contract.md`, `refinement-log.md`.

2026-08-19 | Versioned generated schemas made the structural checker fail because it parsed literal `NEXUS_TOOLS`/`META_TOOLS` arrays that no longer exist. | Changed the checker to resolve the latest CLI/MCP artifacts through `<repo>/schemas/manifest.json` and filter CLI tools through the advertised eval catalog; documented schema pinning and the loader path. | `scripts/check_scenarios.py`, `references/harness-map.md`, `protocols/configure-a-run.md`.

2026-08-14 | Rebuilt from a single prose file through the skill-crafter
improve-skill protocol. The old file was a knob list with no procedure, no
verification, and several claims that did not match `tests/eval/`: it said
`EVAL_TOOL_SET=meta` restricts the model to the two-tool contract (the harness
always presents that surface; the flag only filters which scenarios run), it
described the run as parallel via `Promise.all` without the local-provider
serial case, its env list omitted several live knobs, and it pinned model slugs
that go stale. | Split into a router plus `protocols/` (add-a-scenario,
configure-a-run, debug-a-run, extend-the-harness, self-refine), `references/`
(harness-map, scenario-contract, run-behavior) and
`scripts/check_scenarios.py`, which derives the scenario field list from
`tests/eval/types.ts` and the tool names from `tests/eval/fixtures/tools.ts` and
fails on the selector-blind `getTools` trap. | every file in this skill.
