# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-15 | Cutting 5.17.0. An `**Unreleased**` changelog entry already existed
and read as finished, but it had been written when the first feature of the cycle
landed and covered 2 of the 41 commits since 5.16.4 — Defuddle web capture, the
provider error-frame fix, two new models, Perplexity pricing, the workspace-delete
and IPC-socket fixes were all merged after it and would have shipped undocumented.
`cut-release.md` step 4 already says to verify an existing entry "against what
actually merged", but nothing made that mechanical, and prose loses to an entry
that looks complete. | Added `check_changelog_coverage()` to
`check_release_ready.py`: it diffs the `#NNN` references in the commits since the
previous bare-semver tag against those in the new version's changelog block and
warns with the ones the entry never mentions. A warning, not an error — CI, build
and internal work legitimately earn no bullet, so this is a triage list. Needed
read-only git (`tag`, `log`), so the script's "does not run git" claim was
corrected rather than left wrong; the check skips itself when git cannot answer.
| `scripts/check_release_ready.py`.

2026-08-14 | Skill had never been checked against the repo: it forbade the
`version` npm lifecycle script as "stale" (it is current and correct), listed a
version line in `CLAUDE.md` that does not exist, and named an orphaned
`docs/features/` tree that is gone. It also had no mechanical check, so a
half-done bump could only be caught by the workflow after the tag was pushed. |
Rebuilt as a router plus protocols/references, corrected every claim against the
tree, and added `scripts/check_release_ready.py`, which reproduces the workflow's
version guard locally. | whole skill.
