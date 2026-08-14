# Protocol: diagnose missing, stale or resurrected data

Context: run this when data is not where someone expects it — absent from a view,
stale after a sync, duplicated, gone after a rebuild, or back after a rebuild.

## Mission
Locate the failure on one side of the JSONL/SQLite line before changing any code,
then fix it at that layer.

## Steps

1. Capture the exact symptom and the platform (desktop or mobile — the cache
   backends differ). Match it against `../references/failure-modes.md`; most
   reports are already there with the cause named.
2. Bisect with a rebuild. Run "Nexus: Rebuild cache" and observe:
   - **Data appears after the rebuild** → the cache was stale or corrupt; the event
     store is fine. Look at the write path's cache update and the query cache
     invalidation.
   - **Data disappears after the rebuild** → it was never persisted, or its event
     type has no applier case in src/database/sync. Go to `persist-new-data.md`.
   - **No change** → the data is genuinely absent from the event store, or the
     reader is looking in the wrong place. Continue.
   Rebuild is safe: it only destroys what is rebuildable by definition.
3. Look on disk before theorising. The layout is
   `<dataPath>/<category>/<id>/shard-NNNNNN.jsonl` — a directory of shards, with a
   category prefix. Resolve `dataPath` through `resolveVaultRoot` rather than
   guessing; see `../references/paths-and-layout.md`.
4. Rule out a hydration race. If the data exists on disk and in the cache but a
   view shows nothing, check whether the reader awaits `waitForQueryReady()`. This
   is the most common cause of "no data" reports and it is not a storage bug.
5. Rule out a schema split. If the symptom is "works for me, broken for a new
   user" or vice versa, run from the repo root:
   ```bash
   python3 .claude/skills/nexus-storage/scripts/check_schema_consistency.py .
   ```
   A drift report means the upgrade and fresh-install paths disagree; fix it with
   `change-schema.md`.
6. Fix at the layer the bisection identified — never by writing directly to SQLite
   to paper over a missing event, and never by widening a read to compensate for a
   field that should have a column.
7. Add a regression test at that layer: an applier test for replay gaps, a
   repository test for write-order bugs, a readiness test for hydration races. See
   `nexus-testing` for the lane and for the in-app loop that reproduces the
   original symptom.
8. Stop condition: the original symptom is reproduced, fixed, and covered by a test
   that fails without the fix.

## Guidelines
- Pattern: reach for "Nexus: Refresh synced data" before "Nexus: Rebuild cache"
  when the complaint follows a sync — it re-reconciles without discarding.
- Pattern: reproduce on the platform that reported it. IndexedDB and vault-adapter
  cache backends fail differently.
- Anti-pattern: repairing user data by hand-editing JSONL shards. Conflict-copy
  siblings and shard cursors make that riskier than a rebuild.
- Anti-pattern: concluding "sync bug" without checking hydration ordering first.

## Next
If the fix touches the schema, continue with `change-schema.md`; if it adds an
event or an applier case, continue with `persist-new-data.md`. Otherwise this is
terminal — run `self-refine.md` at the end of the session.
