# HybridStorageAdapter Split — Scoping Document

**Status:** Proposal
**Date:** 2026-06-11
**Driver:** Tech-debt audit 2026-06-10 (`docs/audits/plugin-audit-2026-06-10.md`): `HybridStorageAdapter.ts` has grown to 1292 lines (~600 at last tech-debt snapshot). Every entity's CRUD passes through it; it is the single highest-risk file to modify in the codebase.

---

## Problem

`src/database/adapters/HybridStorageAdapter.ts` (1292 lines) is the storage facade implementing `IStorageAdapter`. It currently owns five distinct jobs:

| Responsibility | Lines (approx) | Contents |
|---|---|---|
| **Construction wiring** | 195–280 | Builds `JSONLWriter`, `SQLiteCacheManager`, `SyncCoordinator`, `QueryCache`, `PluginScopedStorageCoordinator`, `CacheBlobStore`, all 8 repositories, `ExportService` |
| **Init & readiness lifecycle** | 281–661 | `initialize(blocking)`, `applyStoragePlan`, `wireReconcilePipeline`, `reconcileMissing{Workspaces,Conversations,Tasks}`, `isReady`/`isQueryReady`/`waitForReady`/`waitForQueryReady`/`getInitError` |
| **Accessors & teardown** | 669–738 | `cache`/`getSqliteCache`, repo getters (`messages`, `projects`, `tasks`), `close()` |
| **Maintenance & sync surface** | 739–1005 | `rebuildCache`, `onExternalSync`/`offExternalSync`, `startJsonlVaultWatcher`/`stop…`, `sync()`, `relocateVaultRoot` |
| **Entity delegation** | 1006–1266 | ~50 one-line arrow-function delegates to repositories + export (`getWorkspace`, `createSession`, `saveState`, `addTrace`, `addMessage`, …) |

Two facts shape the options:

1. **Extraction has already started and works.** `src/database/adapters/lifecycle/` holds `StartupHydrationController`, `InitLifecycleController`, and `ReconciliationCoordinator`, consumed by the adapter as members (`hydration`, `initLifecycle`, `reconciliationCoordinator`). The split should continue this seam, not invent a parallel one.
2. **The delegation block is not the problem.** Lines 1006–1266 are interface-mandated one-liners (the `IStorageAdapter` contract). Splitting them per-domain adds indirection without reducing risk or line count meaningfully. They should stay.

**Consumers:** 21 files reference the class — `ServiceDefinitions`/`PluginLifecycleManager`/`AgentInitializationService` (construction + lifecycle), `ChatView`/`SubagentController`/`TaskBoardView`/`WorkspacesTab`/`StatesSectionRenderer` (entity methods + readiness), `SyncCoordinator`/`JsonlVaultWatcher`/`ReconciliationCoordinator` (internal collaborators). Only the **constructor signature** and **public surface** matter to them; internal layout is free to change.

---

## Options

### Option A — Extract construction wiring only
Move ctor body (backend + repository assembly) into a `HybridStorageAssembly` factory (`src/database/adapters/HybridStorageAssembly.ts`); the adapter constructor calls it and receives a typed bundle.

- **Files touched:** 2 (adapter + new file)
- **LOC moved:** ~120–150
- **Risk:** Low — pure code motion, no behavior or signature change
- **Result:** ~1150 lines. Helps the next reader, doesn't solve the heft.

### Option B — A + extract the maintenance/sync surface (recommended)
Continue the `lifecycle/` pattern: move `rebuildCache`, `sync()`, `relocateVaultRoot`, the JSONL vault watcher pair, and the three `reconcileMissing*` methods into a `StorageMaintenanceService` (`src/database/adapters/lifecycle/StorageMaintenanceService.ts`) owning `rebuildInFlight`, the watcher handle, and the `externalEvents` emitter. Adapter keeps thin public wrappers (the public API does not move).

- **Files touched:** 4 (adapter, assembly, new service, lifecycle index)
- **LOC moved:** ~400–450 total (A + B)
- **Risk:** Medium — `rebuildCache` and the watcher interact with `hydration`/`initLifecycle` state; the service needs those controllers injected, which is exactly how `ReconciliationCoordinator` already works
- **Result:** adapter ~700 lines = wiring call + lifecycle orchestration + accessors + interface delegates. Each remaining line is either contract or orchestration.

### Option C — Full decomposition (split entity delegates per domain)
Also break lines 1006–1266 into per-domain facades (`WorkspaceStorageFacade`, …).

- **Risk:** Higher; touches all 21 consumers' import patterns or adds a second hop to every storage call
- **Benefit:** Cosmetic — the delegates are already one-liners
- **Verdict:** Not recommended. Explicit non-goal.

---

## Recommendation (phased; each phase is an independent, behavior-preserving PR)

**Phase 0 — Characterization tests first (blocker for everything else).**
`tests/unit/HybridStorageAdapter.test.ts` (18 tests) covers startup hydration, `applyStoragePlan`, `waitForQueryReady`, rebuild recovery, and `reconcileMissingConversations` — i.e., the lifecycle. It does **not** cover: `rebuildCache` progress/idempotency (`rebuildInFlight` coalescing), `onExternalSync`/watcher event flow, `relocateVaultRoot`, `close()` teardown ordering, or a delegation smoke (one round-trip per entity through the public surface). Add those (~10–15 tests) against the current code before moving anything.

**Phase 1 — Option A** (construction wiring → `HybridStorageAssembly`). Small PR, pure motion.

**Phase 2 — Option B remainder** (maintenance/sync → `lifecycle/StorageMaintenanceService`). The Phase 0 tests must pass unchanged.

**Phase 3 — stop.** Re-evaluate only if the file grows again.

## Non-goals
- No change to the `IStorageAdapter` interface, constructor options shape, storage format, JSONL event shapes, or `ExternalSyncEvent` payloads.
- No repository-layer changes (PR #256 just touched those; don't overlap).
- No behavior change anywhere — code motion only, pinned by Phase 0 tests.

## Do not start until
- [ ] PR #256 (repository JSON-parse logging) is merged — it edits the repositories this work moves around.
- [ ] PR #254 (secret storage) is merged or closed — it added `AppRuntimeContext` consumers of `getSqliteCache()`; keep that accessor stable.
- [ ] The audit PR queue (#250–#259) is settled enough that no other open branch touches `src/database/`.

## Effort & risk summary

| Phase | Effort | Risk |
|---|---|---|
| 0 — characterization tests | 0.5–1 day | None (test-only) |
| 1 — assembly extraction | 2–3 h | Low |
| 2 — maintenance service | 0.5–1 day | Medium |
