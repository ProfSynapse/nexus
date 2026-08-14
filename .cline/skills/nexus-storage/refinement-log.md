# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

- 2026-08-14 | Improve-skill pass: the skill was one prose file with no procedure,
  no progressive disclosure and nothing that verified it. Verifying the three-step
  schema claim against the tree turned up a fourth edit nobody had documented —
  `SCHEMA_SQL` stamps `schema_version` at the end of the template, so fresh
  installs skip migrations entirely. | Split into a router plus protocols,
  references and a schema-consistency script that checks the version stamp
  mechanically. | SKILL.md, all of protocols/ and references/, and
  scripts/check_schema_consistency.py.
