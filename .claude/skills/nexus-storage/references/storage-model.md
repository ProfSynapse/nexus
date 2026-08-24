# The storage model and what it forbids

Read this before writing persistence code. Everything else in this skill follows
from three invariants.

## 1. JSONL is the source of truth; SQLite is rebuildable

Repositories under src/database/repositories write in one order, inside a
transaction: **append the event to JSONL, then update SQLite, then invalidate the
query cache.** WorkspaceRepository.create is the canonical example.

This ordering is durability, not cross-instance mutual exclusion. A
read-missing → append-started → dispatch sequence can admit two owners unless the
claim operation reports which contender won. If SQLite uses `INSERT OR IGNORE`
as that claim, the repository must inspect and return the affected-row result;
discarding it lets losing contenders execute anyway. Tests for this contract
need two service/repository owners and a barrier after both missing reads.

The "Nexus: Rebuild cache" command (registered in
src/core/commands/MaintenanceCommandManager.ts, implemented by
StorageMaintenanceService.rebuildCache) stops autosave, closes the SQLite cache,
**removes the cache blob**, reopens an empty database, and replays the event store
through SyncCoordinator.fullRebuild. The JSONL store is never touched.

Consequences:

- A write that lands only in SQLite is deleted the next time a user rebuilds. It
  will look perfectly fine until then.
- Replay goes through the event appliers in src/database/sync
  (WorkspaceEventApplier, ConversationEventApplier, TaskEventApplier). Their
  `apply` methods are a `switch` on `event.type` **with no default branch** — an
  event type no applier handles is silently dropped during replay. The data is in
  JSONL and simply never reaches the cache.
- Therefore: rebuilding the cache is the definitive test of whether data is
  actually persisted. If it survives a rebuild it is real; if it disappears, it
  was only ever cached.

## 2. The cache is cold before it is warm

Startup hydration is a phase machine (StartupHydrationController: idle → running →
complete | error) and queries issued during it see an empty database, not an error.

`waitForQueryReady()` is optional on `IStorageAdapter` and implemented by
`HybridStorageAdapter`; it resolves when hydration leaves the running phase, with
an idle timeout as a safety net. Callers that already do this correctly and are
worth copying: TaskBoardDataController, TaskService, DualBackendExecutor,
ProjectsManagerView. Each guards with `typeof adapter.waitForQueryReady ===
'function'` because the method is optional on the interface.

A read that races startup without awaiting readiness renders "no data" for data
that exists. That is the single most common "bug report" in this area and it is
almost never a storage bug.

## 3. Roots are resolved, never hardcoded

The vault storage root is a user setting with a default; the plugin folder name
varies by install (`nexus` vs `claudesidian-mcp`). Both have resolvers, and legacy
locations are read/migration fallbacks that must never be written to. See
`paths-and-layout.md`.

## What this model buys, and the price

Rebuild is safe by design: it is the correct answer to a corrupt or suspect cache,
and it cannot lose real data. The price is that the two stores can disagree, and
every disagreement traces back to one of:

- a write that skipped the event (invariant 1),
- an event with no applier (invariant 1),
- a read that raced hydration (invariant 2),
- a schema that exists on one install path but not the other (`schema-rules.md`),
- a path resolved differently than it was written (`paths-and-layout.md`).

`failure-modes.md` maps symptoms back to these five.
