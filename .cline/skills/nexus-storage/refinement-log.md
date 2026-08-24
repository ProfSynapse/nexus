# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-24 | A 2026-08-21 entry below repointed this skill's validator command at
`.codex/skills` on the premise that the `.claude/skills` mirror had been removed.
The premise was false: `scripts/sync-agent-context.mjs` copies `.skills/` into all
three mirrors byte-for-byte with no path rewriting, so both mirrors exist and a
mirror-local path cannot survive a sync — the edit only produced drift. | Restored
the canonical `.claude/skills` path used by the rest of the skills (63 references
to 0). Edit `.skills/` and run `npm run sync:skills`; never edit a mirror. |
`protocols/self-refine.md`, `refinement-log.md`.

- 2026-08-23 | A failed vault-root migration left SQLite state metadata visible
  to `list-states` while `load-state` could not read the intact `state_saved`
  body in the destination shard. Fresh states worked only from the repository's
  in-memory cache. The symptom map had no entry for this split read policy. |
  Added a failure-mode entry that checks the persisted migration state, proves
  metadata/event/cache behavior separately, forbids shard repair by hand, and
  records the destination-first read invariant for every migration phase. |
  references/failure-modes.md.
- 2026-08-21 | The terminal validation recipe still targeted the removed
  `.claude/skills` mirror, while this repository owns project skills under
  `.codex/skills`; following the stale path cannot validate the skill. | Pointed
  the recipe at the live project skill and made skill-crafter installation
  resolution explicit. | `protocols/self-refine.md`, `refinement-log.md`.

- 2026-08-21 | Receipt review exposed a gap between JSONL-first durability and
  ownership: two service instances can both read a missing receipt, append a
  start, and dispatch when the SQLite `INSERT OR IGNORE` result is discarded. |
  Clarified that write ordering is not mutual exclusion and documented the
  two-owner/barrier proof required for an atomic claim. |
  `references/storage-model.md`, `refinement-log.md`.

- 2026-08-21 | Invoking the Obsidian `nexus:rebuild-cache` command from the CLI
  returned successfully after opening its confirmation modal, so the first live
  receipt test incorrectly treated a pending user decision as a completed
  rebuild until the user pressed the button. | Made confirmation of the in-app
  modal an explicit part of the real replay gate. | protocols/persist-new-data.md.

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

- 2026-08-15 | Fixing permanent workspace deletion: the "Data reappeared after a
  rebuild" entry pointed at a missing deletion event, but the delete already
  appended one and the data came back anyway. Three facts the skill did not
  carry decided the bug, and each cost a source read: the applier handling the
  tombstone was narrower than the live delete, FK enforcement is off so no
  declared `ON DELETE CASCADE` ever fires (`grep -rn "foreign_keys" src/`
  returns nothing), and a workspace owns two streams — `workspaces/ws_<id>` and
  `tasks/tasks_<id>` — so a tombstone in one says nothing about the other. |
  Sharpened the entry with the three additional conditions and named
  `rebuildCache()` plus a per-table count in the running app as the check.
  | references/failure-modes.md.
