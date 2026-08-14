# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-14 | Skill had never been checked against the repo: it forbade the
`version` npm lifecycle script as "stale" (it is current and correct), listed a
version line in `CLAUDE.md` that does not exist, and named an orphaned
`docs/features/` tree that is gone. It also had no mechanical check, so a
half-done bump could only be caught by the workflow after the tag was pushed. |
Rebuilt as a router plus protocols/references, corrected every claim against the
tree, and added `scripts/check_release_ready.py`, which reproduces the workflow's
version guard locally. | whole skill.
