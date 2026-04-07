# SQLiteCacheManager Refactor Plan

Generated: 2026-04-07
Target file: `src/database/storage/SQLiteCacheManager.ts`
Current size: 923 lines on `origin/main`
Current size in worktree: 734 lines
Worktree: `.worktrees/sqlite-cache-manager-refactor`
Branch: `codex/sqlite-cache-manager-refactor`

## Goal

Reduce `SQLiteCacheManager` to a thin storage facade that owns lifecycle state and delegates:

- WASM sqlite module bootstrapping and DB creation/loading
- file persistence and corruption recovery
- low-level typed statement/query execution
- transaction coordination
- maintenance/admin operations such as clear, rebuild, vacuum, and stats

This refactor should also eliminate the current `@typescript-eslint/no-unsafe-*` failures caused by direct interaction with the loosely typed sqlite WASM API.

## Progress Snapshot

Completed so far in this worktree:

- added direct unit coverage for `SQLiteCacheManager`
- extracted `SQLiteWasmBridge`
- extracted `SQLiteTransactionCoordinator`
- extracted `SQLiteSyncStateStore`
- extracted `SQLitePersistenceService`
- reduced `SQLiteCacheManager` from `923` lines to `734` lines
- eliminated the original `@typescript-eslint/no-unsafe-*` failures in `SQLiteCacheManager.ts`

Current validation status:

- targeted Jest suites pass:
  - `tests/unit/SQLiteCacheManager.test.ts`
  - `tests/unit/SQLiteTransactionCoordinator.test.ts`
  - `tests/unit/SQLiteSyncStateStore.test.ts`
  - `tests/unit/SQLitePersistenceService.test.ts`
- focused `eslint` on the changed files passes
- `tsc --noEmit --skipLibCheck` no longer reports any `SQLiteCacheManager` or `SQLiteWasmBridge` issues
- remaining TypeScript/build blockers in this worktree are unrelated baseline issues:
  - `src/services/workflows/WorkflowRunService.ts`
  - `src/ui/chat/services/ModelAgentManager.ts`
  - `src/core/PluginLifecycleManager.ts` `no-console` warning during lint

## Current Responsibility Clusters

### 1. WASM initialization and database open/load

Methods:

- `resolveSqliteWasmPath()`
- `initialize()`
- `getSqlite3OrThrow()`
- `getDbOrThrow()`

Problems:

- mixes vault filesystem lookup, WASM binary loading, console suppression, module init, DB open/create, schema bootstrap, migration, and autosave timer startup
- owned the most lint-heavy untyped API boundary before the bridge extraction

### 2. File persistence and corruption recovery

Methods:

- `loadFromFile()`
- `saveToFile()`
- `recreateCorruptedDatabase()`
- part of `close()`

Problems:

- deserialize/export logic is mixed with corruption recovery and save policy
- file persistence is intertwined with raw DB lifecycle mutation

### 3. Query and statement execution

Methods:

- `exec()`
- `query()`
- `queryOne()`
- `run()`
- internal `DatabaseAdapter`

Problems:

- low-level statement lifecycle used to be repeated inline
- now routed through `SQLiteWasmBridge`, but the manager still owns too many lifecycle concerns around it

### 4. Transaction coordination

Methods:

- `beginTransaction()`
- `commit()`
- `rollback()`
- `transaction()`

Status:

- extracted to `SQLiteTransactionCoordinator`

### 5. Sync/event/admin operations

Methods:

- `isEventApplied()`
- `markEventApplied()`
- `getAppliedEventsAfter()`
- `getSyncState()`
- `updateSyncState()`
- `clearAllData()`
- `rebuildFTSIndexes()`
- `vacuum()`
- `getStatistics()`
- `getStats()`

Status:

- sync/event persistence extracted to `SQLiteSyncStateStore`
- maintenance/admin operations still live in the manager

## Existing Test Surface

Direct coverage now includes:

- `tests/unit/SQLiteCacheManager.test.ts`
- `tests/unit/SQLiteTransactionCoordinator.test.ts`
- `tests/unit/SQLiteSyncStateStore.test.ts`

Indirect coverage:

- repository tests that mock the cache interface, not the real implementation
- `HybridStorageAdapter` tests with mocked sqlite cache
- embedding/indexer tests that depend on the cache type but not the real WASM-backed implementation

## Refactor Strategy

### 1. Add a typed sqlite boundary first

Collaborator:

- `src/database/storage/SQLiteWasmBridge.ts`

Status: Complete

### 2. Extract file persistence and recovery

Collaborator:

- `src/database/storage/SQLitePersistenceService.ts`

Status: Complete

### 3. Extract transaction coordination

Collaborator:

- `src/database/storage/SQLiteTransactionCoordinator.ts`

Status: Complete

### 4. Extract sync/maintenance services

Collaborators:

- `src/database/storage/SQLiteSyncStateStore.ts`
- `src/database/storage/SQLiteMaintenanceService.ts`

Status:

- sync state store complete
- maintenance service pending

## Recommended Next Step

Extract `SQLiteMaintenanceService` next.

Reason:

- it is the largest remaining coherent block in `SQLiteCacheManager`
- it will move destructive maintenance and statistics out of the manager
- it should get the manager close to the final facade shape without forcing artificial micro-extractions

Secondary next step after that:

- decide whether the remaining manager size is acceptable after maintenance extraction or whether one final lifecycle/bootstrap split is still warranted

## Exit Criteria

- `SQLiteCacheManager.ts` drops below roughly 650 lines
- repo-wide lint no longer fails on this file
- public `IStorageBackend` and `ISQLiteCacheManager` behavior remains unchanged
- corruption recovery and persistence semantics remain unchanged
- transaction ordering semantics remain unchanged
- no search behavior regressions

## Stop Condition

Stop once `SQLiteCacheManager` is clearly a facade over:

- lifecycle/bootstrap state
- typed sqlite execution
- persistence
- transactions
- sync/admin helpers

Do not keep splitting after that into tiny helper classes with no meaningful boundary.
