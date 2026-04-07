# Implementation Plan: Plugin-Scoped Sync Storage Migration

> Drafted on 2026-04-06
> Status: PROPOSED

## Summary

Move Nexus sync-critical source-of-truth data from the hidden vault root folder `.nexus/` to plugin-scoped storage under the active plugin directory. The target layout should use `data.json` for lightweight control-plane state and `data/` for append-only event files.

This change is driven by Obsidian Sync behavior: hidden files and folders that start with `.` are excluded from sync, except for `.obsidian`. That makes `.nexus/` incompatible with reliable desktop-to-mobile sync, while plugin-scoped storage under `.obsidian/plugins/<resolved-plugin-folder>/` is sync-eligible.

The migration must be **copy-only**. It must never delete, mutate, or garbage-collect the old `.nexus/` folder automatically. The old store remains readable as a fallback during a compatibility window.

---

## Specialist Perspectives

### Preparation Phase
**Effort**: Medium

#### Research Needed
- [x] Confirm Obsidian Sync excludes hidden root dotfolders like `.nexus/`
- [x] Confirm `.obsidian` is the exception and syncs
- [x] Confirm `Plugin.loadData()` / `Plugin.saveData()` write to `data.json` in the plugin folder
- [x] Confirm this repo already uses runtime plugin directory resolution patterns rather than assuming a single folder name
- [ ] Verify which plugin-scoped files under `.obsidian/plugins/<id>/` are guaranteed to sync on desktop and mobile in the supported Sync configurations
- [ ] Verify whether very large plugin-scoped JSONL sets have practical mobile performance limits

#### Key Findings
- **Current root cause**: `.nexus/` is a hidden root dotfolder, so its files do not reliably sync to mobile under Obsidian Sync.
- **Destination requirement**: the new source of truth must live inside the active plugin directory under `.obsidian/plugins/<resolved-folder>/`.
- **Folder-name compatibility**: the destination must not assume the plugin folder is named `nexus`. Existing users may still have folders such as `claudesidian-mcp`.
- **Naming preference**: `data/` is preferred over `storage/` because it reads as synced user data rather than an internal implementation detail.

#### Questions to Resolve
- [ ] Should cache artifacts remain under the plugin folder or move to a separate local-only location if one is available cross-platform?
- [ ] Should migration verification be strict enough to block cutover if only a subset of files copied, or allow partial per-entity cutover?
- [ ] How long should the old `.nexus/` compatibility window remain in place?

---

### Architecture Phase
**Effort**: High

#### Components Affected
| Component | Change Type | Impact |
|-----------|-------------|--------|
| Storage root resolution | New behavior | Destination derived from runtime plugin directory, not hardcoded folder names |
| `HybridStorageAdapter` | Modify | Read/write path management, migration orchestration, compatibility reads |
| `JSONLWriter` | Modify | New base path under plugin-scoped `data/` |
| Migration services | Modify | Copy-only migration manifest, verification, legacy source probing |
| Maintenance diagnostics | Modify | Report active storage root, migration state, verification state, fallback usage |
| Cache layer | Clarify contract | Cache remains rebuildable and non-authoritative |

#### Design Approach

**Target layout**:
```text
.obsidian/plugins/<resolved-plugin-folder>/
  data.json
  data/
    conversations/
    workspaces/
    tasks/
    sessions/
    migration/
      manifest.json
      verification.json
```

**Data split**:
- `data.json`: settings, storage version, migration state, lightweight indexes, health flags
- `data/`: source-of-truth append-only JSONL records
- cache files: never treated as source of truth

**Path resolution**:
- Destination must be derived from the active plugin runtime context, not from a hardcoded folder name.
- Legacy source locations may be probed heuristically during migration, but steady-state reads and writes must use the resolved active plugin directory.

**Migration model**:
- Copy-only from `.nexus/` to plugin-scoped `data/`
- Idempotent and resumable
- Verification required before preferred reads switch to the new store
- Old `.nexus/` remains available as fallback after migration

#### Key Decisions

| Decision | Options | Recommendation | Rationale |
|----------|---------|----------------|-----------|
| Destination naming | `storage/` / `data/` / `records/` | `data/` | Clearer user-data meaning, pairs naturally with `data.json` |
| Destination root | Hardcoded `nexus` folder / runtime plugin dir | Runtime plugin dir | Supports renamed legacy plugin folders such as `claudesidian-mcp` |
| Migration behavior | Move / copy / rewrite in place | Copy-only | Lowest risk, preserves user data, allows rollback by fallback |
| Cutover timing | Immediate after copy / only after verification | Only after verification | Prevents partial sync states from breaking mobile |
| Legacy support | Hard cutover / dual-read compatibility | Dual-read compatibility | Safer rollout across staggered device upgrades |
| Source-of-truth structure | Single `data.json` blob / per-entity JSONL files | Per-entity JSONL under `data/` | Better fit for append-only chat and workspace history |
| Cache authority | Synced cache / rebuildable cache | Rebuildable cache only | Avoids trusting mutable, conflict-prone cache files |

#### Interface Contracts

**Storage state in `data.json`**:
```typescript
interface PluginScopedStorageState {
  storageVersion: number;
  sourceOfTruthLocation: 'legacy-dotnexus' | 'plugin-data';
  migration: {
    state: 'not_started' | 'copying' | 'copied' | 'verified' | 'failed';
    startedAt?: number;
    completedAt?: number;
    lastError?: string;
    legacySourcesDetected: string[];
    activeDestination: string;
  };
}
```

**Resolved destination contract**:
```typescript
interface ResolvedPluginStorageRoot {
  pluginDir: string;          // Active plugin directory resolved at runtime
  dataJsonPath: string;       // <pluginDir>/data.json
  dataRoot: string;           // <pluginDir>/data
}
```

**Legacy probing contract**:
```typescript
interface LegacyStorageCandidate {
  path: string;
  type: 'dotnexus' | 'other-legacy';
  exists: boolean;
  entityCounts?: {
    conversations: number;
    workspaces: number;
    tasks: number;
    sessions: number;
  };
}
```

---

### Code Phase
**Effort**: High

#### Files to Modify
| File | Changes |
|------|---------|
| `src/core/services/ServiceDefinitions.ts` | Stop hardcoding `.nexus` as the primary storage root |
| `src/database/adapters/HybridStorageAdapter.ts` | Add destination root resolution, migration gating, preferred-read switching |
| `src/database/storage/JSONLWriter.ts` | Support plugin-scoped `data/` root |
| `src/database/migration/*` | Add copy-only migration manifest + verification workflow |
| `src/core/commands/MaintenanceCommandManager.ts` | Add diagnostics/refresh hooks that report migration state clearly |
| `src/settings.ts` or plugin data helpers | Persist migration state in `data.json` |

#### Files to Create
| File | Purpose |
|------|---------|
| `src/database/migration/PluginScopedStorageMigrator.ts` | Copy-only migration coordinator |
| `src/database/migration/PluginScopedStorageVerifier.ts` | Structural verification of copied data |
| `src/database/storage/PluginStoragePathResolver.ts` | Runtime destination path resolution |
| `src/database/migration/types.ts` updates or new types file | Shared migration state / candidate types |

#### Implementation Sequence
1. Introduce runtime plugin-directory path resolution
2. Define plugin-scoped `data/` layout and `data.json` migration state contract
3. Implement legacy-source probing with `.nexus/` as the primary migration source
4. Implement copy-only migration into plugin-scoped `data/`
5. Add verification that compares expected entity presence and basic readability
6. Change read precedence to prefer verified plugin-scoped data, with legacy fallback
7. Change writes to target plugin-scoped data after verification or explicit cutover rules
8. Add diagnostics and recovery commands

#### Read/Write Resolution State Machine

**Startup precedence**:
```text
1. Resolve active plugin directory dynamically
2. Load migration state from data.json
3. If plugin-scoped data is VERIFIED, prefer it
4. Else if legacy .nexus exists, read from legacy and attempt copy-only migration
5. Else if plugin-scoped data exists but is unverified, continue verification and use fallback rules
6. Else initialize empty plugin-scoped data root
```

**Compatibility read rules**:
```text
- Prefer verified plugin-scoped files
- If requested entity missing there, fall back to legacy .nexus during compatibility window
- Never delete legacy files during fallback
```

**Write rules**:
```text
- Before verification: conservative mode, legacy remains readable source; write strategy must avoid divergence
- After verification: write new source-of-truth files to plugin-scoped data/
- Cache writes remain separate from source-of-truth semantics
```

---

### Test Phase
**Effort**: High

#### Test Scenarios
| Scenario | Type | Priority |
|----------|------|----------|
| Fresh install with no `.nexus/` and no plugin-scoped data | Unit/Integration | P0 |
| Existing `.nexus/` copied to plugin-scoped `data/` without deletion | Integration | P0 |
| Copy operation rerun idempotently | Unit/Integration | P0 |
| Verification passes and preferred reads switch to plugin-scoped data | Integration | P0 |
| Verification fails and reads continue from legacy `.nexus/` | Integration | P0 |
| Dynamic plugin directory resolution works for `claudesidian-mcp` and `nexus` installs | Unit | P0 |
| Mobile-style partial sync: destination exists but incomplete | Integration | P0 |
| Missing entity in new store falls back to legacy during compatibility window | Integration | P1 |
| Diagnostics report migration state accurately | Unit | P1 |
| No code path automatically deletes `.nexus/` | Unit | P1 |

#### Coverage Targets
- Migration coordinator: 90%
- Path resolver: 95%
- Verification logic: 90%
- Read precedence / fallback logic: 85%

#### Test Data Needs
- Synthetic `.nexus/` directory trees with representative conversation/workspace/task/session files
- Legacy plugin directory naming variants
- Partial-copy fixtures to simulate interrupted sync or interrupted migration

---

## Synthesized Implementation Roadmap

### Phase Sequence
```text
Step 1: Finalize storage contract (data.json vs data/)
    ↓
Step 2: Implement runtime destination resolution
    ↓
Step 3: Implement copy-only migration + verification
    ↓
Step 4: Switch preferred reads with legacy fallback
    ↓
Step 5: Add diagnostics and rollout guardrails
    ↓
Step 6: Observe one release cycle before any cleanup discussion
```

### Commit Sequence (Proposed)

1. `design: add plugin-scoped sync storage contract and path resolution`
2. `feat: add copy-only migration from legacy dotnexus storage`
3. `feat: prefer verified plugin-scoped data with legacy fallback`
4. `feat: add migration diagnostics and recovery tooling`

---

## Cross-Cutting Concerns

| Concern | Status | Notes |
|---------|--------|-------|
| Data safety | Critical | Copy-only migration, no automatic deletion |
| Sync compatibility | Critical | New source of truth must live under `.obsidian/plugins/<resolved-folder>/` |
| Mobile support | Critical | Must tolerate partial sync and late-arriving files |
| Performance | Moderate | Avoid giant monolithic `data.json`; keep JSONL split by entity |
| Backward compatibility | Critical | Keep legacy `.nexus/` readable during compatibility window |
| User trust | Critical | Diagnostics should explain which storage root is active |

---

## Open Questions

### Require User Decision
- How long should the legacy `.nexus/` fallback window remain in place before considering optional manual cleanup guidance?
- Should writes remain dual-targeted during the compatibility window, or should the cutover happen only after verification on the running device?

### Require Further Research
- [ ] Confirm exact Sync behavior for plugin-scoped subfolders across all supported Sync configurations
- [ ] Decide whether cache files should remain colocated under plugin data or be moved elsewhere when feasible
- [ ] Determine whether lightweight indexes in `data.json` should be authoritative or fully rebuildable from `data/`

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Partial plugin-scoped sync on mobile causes incomplete cutover | High | High | Verification gate + legacy fallback |
| Hardcoded plugin folder name breaks legacy installs | Medium | High | Resolve destination dynamically from runtime plugin directory |
| Large synced `data.json` becomes conflict-prone | Medium | High | Keep transcripts and event logs in `data/`, not `data.json` |
| Divergence between old and new stores during rollout | Medium | High | Copy-only migration, explicit migration states, conservative cutover |
| Users assume `.nexus/` can be deleted manually | Low | Medium | Diagnostics and docs must state that old store remains supported during rollout |

---

## Scope Assessment

- **Overall Complexity**: High (variety score 8)
- **Estimated Files**: 6-10 modified, 3-5 new
- **Specialists Required**: Backend coder, migration-focused architect, test engineer
- **External Dependencies**: None expected

---

## Phase Requirements

| Phase | Required? | Rationale |
|-------|-----------|-----------|
| PREPARE | Yes | Platform sync constraints and runtime path rules must be confirmed |
| ARCHITECT | Yes | Storage contract, migration rules, and fallback semantics are architectural |
| CODE | Yes | Migration + compatibility behavior touches core persistence paths |
| TEST | Yes | Data safety and fallback correctness are mandatory |

---

## Out of Scope

- Automatic deletion of `.nexus/`
- One-shot irreversible cutover with no fallback
- Replacing JSONL event storage with a single `data.json` conversation blob
- Reworking unrelated chat UI or provider logic

---

## Next Steps

To execute this plan after approval:
```text
/PACT:orchestrate Migrate sync-critical storage from .nexus to plugin-scoped data/
```

The orchestrator should reference this plan during execution and preserve the copy-only migration constraint.