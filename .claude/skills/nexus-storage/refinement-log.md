# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

- 2026-08-14 | The hydration-gate entry said "await `waitForQueryReady()`", and the
  notes-index startup did exactly that and still failed: the background startup
  rebuild never left the `running` phase, so the gate resolved false after its 120s
  idle timeout, and the caller discarded the boolean and ran DDL against a
  connection that (when init had failed) did not exist — surfacing as an
  unattributable "Database not initialized". The guidance covered the call but not
  the two ways it does not help. | Added a symptom entry for the gate that never
  opens / whose answer is discarded, with the cold-start reproduction (delete the
  `nexus-cache-blob-store` IndexedDB database, restart) that a plugin reload cannot
  produce. | references/failure-modes.md.

- 2026-08-14 | Improve-skill pass: the skill was one prose file with no procedure,
  no progressive disclosure and nothing that verified it. Verifying the three-step
  schema claim against the tree turned up a fourth edit nobody had documented —
  `SCHEMA_SQL` stamps `schema_version` at the end of the template, so fresh
  installs skip migrations entirely. | Split into a router plus protocols,
  references and a schema-consistency script that checks the version stamp
  mechanically. | SKILL.md, all of protocols/ and references/, and
  scripts/check_schema_consistency.py.
