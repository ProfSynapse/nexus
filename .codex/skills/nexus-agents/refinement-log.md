# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-21 | The self-refinement command checker still targeted the removed
`.claude/skills` mirror and therefore could not validate the live project skill. |
Repointed it at `.codex/skills/nexus-agents`. | `protocols/self-refine.md`,
`refinement-log.md`.

2026-08-21 | The agent/tool contract and failure-mode guidance matched the
reviewed payload, registration, and result paths; the actionable gaps belonged
to adapter identity, persistence ownership, and test-boundary guidance. | No
change. | `refinement-log.md` only.

2026-08-21 | The payload-contract guidance correctly led to a top-level optional
`operationId`, synchronized CLI normalization, and released schema catalogs; no
documented command or contract claim diverged from the tree. | No change. |
`refinement-log.md` only.

2026-08-21 | The documented `npm run schemas:tools -- --output …` command forwarded an unsupported argument through the current npm alias and failed before producing the PR 5 inventory. | Replaced refresh instructions with `npm run schemas:release`, retained direct-generator commands for one-off stdout inspection, and updated the checker recovery message. | `SKILL.md`, `protocols/verify.md`, `protocols/change-payload-contract.md`, `references/failure-modes.md`, `scripts/check_documented_commands.py`, `refinement-log.md`.

2026-08-19 | The agent/tool contract and verification guidance correctly led to sharing the MCP serializer between `tools/list` and the exporter. | No change. | `refinement-log.md`.

2026-08-14 | Skill was a single prose file: no procedure to follow, no
progressive disclosure, nothing that could verify a documented command still
resolved, and several claims restating general engineering knowledge. | Rebuilt
as a router plus protocols, references and two scripts; re-verified every
retained claim against the tree and added the catalog-backed command checker. |
whole skill.
