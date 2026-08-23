# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

- 2026-08-23 | A failed vault-root migration left SQLite state metadata visible
  to `list-states` while `load-state` could not read the intact `state_saved`
  body in the destination shard. Fresh states worked only from the repository's
  in-memory cache. The symptom map had no entry for this split read policy. |
  Added a failure-mode entry that checks the persisted migration state, proves
  metadata/event/cache behavior separately, forbids shard repair by hand, and
  records the destination-first read invariant for every migration phase. |
  references/failure-modes.md.

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

- 2026-08-14 | A bulk import (301 files) plus a reload produced 12+ uncaught
  "Database not initialized" errors, and `diagnose-storage.md` had no entry for
  storage errors raised *by a dead plugin instance* — its bisection assumes the
  data is missing, not that the writer is a ghost. Two session-costing details
  were absent: `ServiceContainer.clear()` only calls `cleanup()` (a `stop()`
  method is dead code), and an instance-level patch on the cache manager records
  nothing because the failing caller holds the previous instance. | Added the
  symptom entry with both survivor shapes, the listener-count probe, and the
  prototype-patch attribution trick. | references/failure-modes.md.
