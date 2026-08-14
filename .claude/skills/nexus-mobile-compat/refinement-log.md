# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-14 | Restructured from a single prose document under the skill-crafter
improve-skill protocol. The reachability rule was stated as a hazard with no way
to check it (issue #221). | Split into protocols/references and added
`scripts/check_mobile_imports.py`, which walks the static import graph from
`src/main.ts` and fails on a reachable Node built-in. | whole skill.
