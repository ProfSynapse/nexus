---
name: nexus-storage
description: How to change, persist, migrate and recover Nexus data without losing it. Use when adding a SQLite table or column, persisting anything that must survive a restart or a cache rebuild, resolving a vault or plugin storage path, or debugging missing, stale, duplicated or post-rebuild-vanished data.
---

# Nexus Storage

Nexus stores data twice on purpose. **The sharded JSONL event store is the source
of truth; SQLite is a cache that is deleted and replayed on demand.** Almost every
storage bug in this repo is a write that landed on the wrong side of that line, or
a read that ran before the cache was ready.

This router points at the procedure for your job. Working from the router alone is
how the three-place schema change becomes a two-place one.

## Workflow

1. Pick the job and open its protocol before editing anything:

   | Your job | Protocol |
   |---|---|
   | Add or change a SQLite table, column or index | `protocols/change-schema.md` |
   | Persist a new kind of data, or make a write survive restart | `protocols/persist-new-data.md` |
   | Data is missing, stale, duplicated, slow, or vanished after a rebuild | `protocols/diagnose-storage.md` |

2. Read `references/storage-model.md` before writing any persistence code. It
   states the three invariants that decide whether a design is legal here. A
   change that breaks one is a data-loss bug that unit tests will happily pass.
3. NEVER hardcode a storage root, and NEVER treat SQLite as authoritative. Resolve
   roots through the resolvers named in `references/paths-and-layout.md`, and write
   through a repository so the event lands in JSONL first.
4. If you touched `SchemaMigrator.ts` or `schema.ts`, run
   `scripts/check_schema_consistency.py` from the repo root and treat a non-zero
   exit as a stop:
   ```bash
   python3 .claude/skills/nexus-storage/scripts/check_schema_consistency.py .
   ```
5. Verify at runtime, not just statically. Every protocol here ends in a
   verification step that a static check cannot substitute for — schema changes
   fail on the upgrade path and the fresh-install path independently, and cache
   bugs only appear after a real rebuild.
6. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map

- `protocols/` — the procedures: change-schema, persist-new-data,
  diagnose-storage, self-refine.
- `references/` — read on demand: `storage-model.md` (invariants and rebuild
  semantics), `paths-and-layout.md` (roots, resolvers, on-disk shapes, cache
  backends), `schema-rules.md` (what a migration may and may not do),
  `failure-modes.md` (symptom → cause → fix).
- `scripts/check_schema_consistency.py` — proves the three schema definitions
  agree. Run it; do not eyeball them.

## Siblings

Storage only. Mobile-safe imports and vault-path confinement are `nexus-mobile-compat`;
test lanes and the in-app verification loop are `nexus-testing`; tools and agents that
consume storage are `nexus-agents`.
