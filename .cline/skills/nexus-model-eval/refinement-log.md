# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-14 | Skill was a single prose file that had never been fact-checked
against `tests/eval/`: it told the reader to run the harness but not how to tell
a model's failure from the harness's, carried a stale "harness fixes already
landed" section, claimed jest exits non-zero when scenarios fail (it does not),
and claimed live mode cannot fuzzy-search (the Obsidian test double implements
`prepareFuzzySearch`). | Rebuilt as a router plus two protocols, two references
and three scripts; re-verified every retained claim against the harness source;
drew an explicit boundary with `nexus-eval-harness` (it owns the instrument,
this skill owns the verdict) and dropped the scenario-satisfiability checker in
favour of that skill's. | whole skill.
