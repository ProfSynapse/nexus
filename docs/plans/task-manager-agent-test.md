# Test Engineering Planning Consultation — TaskManager Agent

## 1. SCOPE IN MY DOMAIN

### Critical Test Scenarios

**A. DAG Validation Logic (HIGHEST PRIORITY — pure functions, high bar)**
- Cycle detection: direct cycles (A→B→A), indirect cycles (A→B→C→A), self-referencing (A→A)
- Topological sort correctness: verify execution order respects all `dependsOn[]` edges
- Diamond dependencies (A depends on B and C, both depend on D): no duplicate processing, correct resolution order
- Dependency resolution: given a task, compute full transitive dependency closure
- Orphan detection: tasks whose `dependsOn` references non-existent taskIds

**B. CRUD Operations (STANDARD)**
- Project CRUD within workspace scope (create, read, update, delete, list)
- Task CRUD within project scope
- Subtask hierarchy via `parentTaskId` (create child, reparent, delete parent cascading behavior)
- Pagination on list operations (following existing `PaginatedResult<T>` pattern)

**C. Event Sourcing / JSONL Storage (HIGH)**
- Event append correctness (create, update, delete, status-change events)
- SQLite cache rebuild from JSONL replay (critical for Obsidian Sync)
- Event ordering and idempotency
- Workspace-scoped isolation: project/task events in one workspace don't leak into another

**D. Workspace Integration (STANDARD)**
- Auto-load active projects/tasks on `loadWorkspace`
- Cross-entity relationships: workspace→project→task→dependsOn + parentTaskId
- Bidirectional linking: task↔vault note association and unlinking

**E. Edge Cases / Error Scenarios (HIGH)**
- Delete project with active tasks: cascade vs error behavior
- Delete task that other tasks `dependsOn`: cascade update or error
- Concurrent modification: two callers update same task (last-write-wins or conflict detection)
- Large DAG: 100+ tasks in a project, deep chains (10+ levels), wide fan-out (task with 20+ dependents)
- Empty/null `dependsOn[]`, task with no dependencies, task with no dependents
- Status transitions: e.g., "ready" (all deps complete) vs "blocked" (deps pending)

### Coverage Targets

Following the project's per-file threshold pattern:

| Component | Lines | Branches | Functions | Rationale |
|-----------|-------|----------|-----------|-----------|
| DAG validation / cycle detection (pure logic) | 95% | 90% | 100% | Pure functions, highest bar |
| Topological sort (pure logic) | 95% | 90% | 100% | Pure functions |
| Task/Project repository | 80% | 75% | 80% | Service with mocked DB |
| JSONL event applier | 80% | 75% | 80% | Similar to existing WorkspaceEventApplier |
| Tool handlers (create/update/delete/list) | 75% | 70% | 80% | Delegation layer |
| Vault note linking | 75% | 70% | 80% | Integration with Obsidian API |

### Estimated Effort

- **DAG logic tests**: ~80-100 test cases (cycle detection, topological sort, dependency resolution, edge cases)
- **CRUD/Repository tests**: ~40-60 test cases
- **Event sourcing tests**: ~20-30 test cases
- **Tool handler tests**: ~30-40 test cases
- **Integration/edge cases**: ~20-30 test cases
- **Total**: ~190-260 test cases, approximately 3-5 test files

---

## 2. DEPENDENCIES & INTERFACES

### Existing Test Infrastructure to Reuse
- **Jest config**: `jest.config.js` with ts-jest, `tests/mocks/obsidian.ts` module alias
- **Setup**: `tests/setup.ts` (10s timeout, mock console.error, clearAllMocks between tests)
- **Mock factory pattern**: `createMockDependencies()` (from ConversationIndexer tests) — creates mock DB, mock services, collects callback invocations
- **Per-file coverage thresholds**: Add new entries to `jest.config.js` for TaskManager source files

### New Mocks/Fixtures Needed

**Mock factory — `tests/mocks/taskManager.ts`**:
- `createMockTaskRepository()` — CRUD operations returning configurable data
- `createMockProjectRepository()` — same pattern
- `createMockDAGService()` — validates deps, returns topological order

**Test fixtures — `tests/fixtures/taskManager.ts`**:
- `createTask(overrides?)` — task with sensible defaults (id, title, status, projectId, dependsOn, parentTaskId)
- `createProject(overrides?)` — project with defaults
- `createLinearChain(n)` — builds a chain of n tasks where each depends on the previous
- `createDiamondDAG()` — classic diamond pattern (4 tasks)
- `createCyclicDAG()` — invalid graph for cycle detection tests
- `createWideDAG(fanOut)` — single root with many dependents
- `createDeepDAG(depth)` — long chain for performance/stack overflow testing

### Test Data Patterns for DAG Structures

Use builder functions that return `{ tasks: Task[], edges: [string, string][] }` so tests can construct, inspect, and mutate graphs declaratively. This keeps test setup readable and avoids brittle positional assertions.

---

## 3. KEY DECISIONS & TRADE-OFFS

### DAG Validation: Pure Function vs Service Method

**Recommendation**: Extract cycle detection and topological sort as **pure functions** (e.g., `src/agents/taskManager/utils/dagUtils.ts`). Benefits:
- Testable without any mocking (highest confidence)
- 100% branch coverage achievable
- Can test with large randomly-generated graphs for property-based testing

Input shape: `(tasks: {id, dependsOn}[]) => ValidationResult`. No DB, no repos, no side effects.

### Unit vs Integration Test Split

| Layer | Test Type | Mock Strategy |
|-------|-----------|---------------|
| DAG utils (pure) | Unit | No mocks needed |
| Repository (CRUD) | Unit | Mock SQLiteCacheManager + JSONLWriter |
| Event applier | Unit | Mock DB (run/query methods) |
| Tool handlers | Unit | Mock repository + DAG service |
| Auto-load on workspace | Integration | Mock workspace service + repo together |

**No need for real SQLite in tests** — existing project pattern mocks the DB at the `run`/`query`/`queryOne` level (see ConversationIndexer tests). This keeps tests fast and deterministic.

### Status Transition Logic

If tasks have computed statuses ("ready" when all deps complete, "blocked" otherwise), this should be a pure function: `computeTaskStatus(task, allTasks) -> Status`. Test it independently from CRUD.

---

## 4. RISKS & CONCERNS

### High-Risk Edge Cases

| Risk | Severity | Test Strategy |
|------|----------|---------------|
| Circular dependency not detected | CRITICAL | Exhaustive cycle detection tests: self-ref, direct cycle, indirect cycle (3+), cycle within subtree |
| Topological sort incorrect order | CRITICAL | Verify output order satisfies all edges; test with known-answer DAGs |
| Delete task breaks dependents' `dependsOn` arrays | HIGH | Test cascade update: remove deleted taskId from all dependents' `dependsOn[]` |
| Delete project with tasks | HIGH | Test both strategies (cascade delete vs error-if-non-empty) — architect should decide which |
| Orphaned `parentTaskId` after parent delete | HIGH | Test that child tasks are either reparented or error is raised |
| JSONL replay produces different SQLite state | HIGH | Rebuild cache, compare result to original state |
| Large DAG stack overflow | MEDIUM | Test with depth=100+ chain to verify iterative (not recursive) algorithm |
| Concurrent add-dependency creating cycle | MEDIUM | Simulate: task A adds dep on B, task B adds dep on A "simultaneously" |

### Performance Concern

If cycle detection or topological sort is O(V+E) (expected), test with 500-task DAGs to confirm no quadratic behavior. A simple timing assertion (< 100ms) catches regressions.

### Consistency Between JSONL and SQLite

This is the same pattern used by conversations/workspaces. Test the event applier with a sequence of events and verify the SQLite cache matches expected state after replay. This is the most important integration-level test.

---

## 5. RECOMMENDED APPROACH

### Test File Structure

```
tests/
  fixtures/
    taskManager.ts          # Task/Project builders, DAG factory functions
  mocks/
    taskManager.ts          # Mock repos, mock DAG service
  unit/
    DAGUtils.test.ts        # Pure function tests: cycle detection, topological sort, dependency resolution
    TaskRepository.test.ts  # CRUD operations with mocked DB
    ProjectRepository.test.ts  # Project CRUD with mocked DB
    TaskEventApplier.test.ts   # JSONL event replay tests
    TaskManagerTools.test.ts   # Tool handler tests (create/update/delete/list/link)
```

### Critical Test Scenarios by Priority

**P0 — Must have (blocks release):**
1. Cycle detection catches all cycle types (self, direct, indirect, diamond-with-cycle)
2. Cycle detection allows valid DAGs (linear, diamond, wide fan-out)
3. Topological sort returns valid order for known DAGs
4. CRUD happy paths (create task with deps, read, update deps, delete)
5. Dependency cascade on delete (remove from others' `dependsOn`)

**P1 — Should have (quality):**
6. Workspace-scoped isolation (project in workspace A not visible from workspace B)
7. Subtask hierarchy (parentTaskId create, list children, reparent)
8. Event replay produces correct SQLite state
9. Bidirectional vault note linking/unlinking
10. Pagination for list operations
11. Status computation based on dependency state

**P2 — Nice to have (robustness):**
12. Large DAG performance (500+ tasks, sub-100ms)
13. Concurrent modification scenarios
14. Empty/edge inputs (null title, empty dependsOn, missing projectId)
15. Property-based testing: random valid DAGs always produce valid topological order

### Existing Patterns to Follow

1. **Mock factory per domain** — `createMockDependencies()` (from ConversationIndexer.test.ts)
2. **Fixture builders with overrides** — `createAlternativeMessage(overrides)` (from chatBugs.ts fixtures)
3. **Per-file coverage thresholds** — tiered by purity (see jest.config.js pattern)
4. **Replicate private logic for testing** — if DAG validation is private, replicate the algorithm in test helpers (as done with `convertAlternativesToEvent` in MessageRepository.test.ts) — though I strongly recommend making DAG utils public/exported pure functions instead

### Coverage Threshold Additions to `jest.config.js`

```js
// DAG logic: pure functions (highest bar)
'./src/agents/taskManager/utils/dagUtils.ts': {
  branches: 90, functions: 100, lines: 95, statements: 95
},
// Task repository: service with mocked DB
'./src/agents/taskManager/services/TaskRepository.ts': {
  branches: 75, functions: 80, lines: 80, statements: 80
},
// Project repository
'./src/agents/taskManager/services/ProjectRepository.ts': {
  branches: 75, functions: 80, lines: 80, statements: 80
},
// Event applier
'./src/database/sync/TaskEventApplier.ts': {
  branches: 75, functions: 80, lines: 80, statements: 80
},
```

---

## Summary

The DAG validation logic is the highest-risk, highest-value testing target — it should be extracted as pure functions and tested exhaustively. CRUD/repository tests follow established mock-factory patterns. Event sourcing tests verify JSONL-to-SQLite consistency. Total estimated scope: ~200+ tests across 5 files. No new test infrastructure needed beyond domain-specific fixtures and mock factories.

## Open Questions for Architect

- What happens on delete-project-with-tasks? (cascade vs error — needs architect decision)
- What happens on delete-task-with-dependents? (remove from dependsOn[] vs error)
- Should orphaned parentTaskId references be auto-cleaned or error?
- Will status transitions (ready/blocked) be computed or stored?
