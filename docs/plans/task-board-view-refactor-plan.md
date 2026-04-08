## TaskBoardView Refactor Plan

Branch: `codex/taskboard-analysis`
Worktree: `/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis`

### Current state

- File: [TaskBoardView.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts)
- Original size: `1008` lines
- Current size after renderer extraction: `453` lines
- Current direct unit coverage:
  - [TaskBoardDataController.test.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/tests/unit/TaskBoardDataController.test.ts)
  - [TaskBoardFilterController.test.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/tests/unit/TaskBoardFilterController.test.ts)
  - [TaskBoardGroupingService.test.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/tests/unit/TaskBoardGroupingService.test.ts)
  - [TaskBoardEditCoordinator.test.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/tests/unit/TaskBoardEditCoordinator.test.ts)
  - [TaskBoardSyncCoordinator.test.ts](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/tests/unit/TaskBoardSyncCoordinator.test.ts)

### Progress

- Batch 1 complete:
  - extracted `TaskBoardDataController`
  - extracted `TaskBoardFilterController`
  - added direct unit tests for data loading and filter behavior
- Batch 2 partial:
  - extracted `TaskBoardGroupingService`
  - added direct unit tests for swimlane grouping and progress behavior
- Batch 3 complete:
  - extracted `TaskBoardEditCoordinator`
  - extracted `TaskBoardSyncCoordinator`
  - added direct unit tests for save orchestration, optimistic rollback, and pending event deferral
- Batch 4 complete:
  - extracted `TaskBoardRenderer`
  - moved column/swimlane/card assembly and drag/drop/link-open behavior out of `TaskBoardView`
- Next recommended slice: package and verify this branch as a PR-sized refactor, then move to the next large file

### Main problem areas

1. Startup and service bootstrap are mixed into the view lifecycle.
   - `onOpen()`, `initializeView()`, `ensureServices()`, and `loadBoardData()` combine retry policy, service discovery, task-agent lookup, workspace/project/task loading, and event registration.
   - References:
     - [TaskBoardView.ts:125](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L125)
     - [TaskBoardView.ts:155](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L155)
     - [TaskBoardView.ts:188](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L188)
     - [TaskBoardView.ts:218](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L218)

2. Toolbar/filter state and stats are tightly coupled to rendering.
   - `ensureValidFilters()`, `refreshProjectDropdown()`, `renderToolbar()`, and parts of `refreshColumns()` all manipulate the same filter and derived-state concerns.
   - References:
     - [TaskBoardView.ts:280](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L280)
     - [TaskBoardView.ts:327](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L327)
     - [TaskBoardView.ts:346](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L346)
     - [TaskBoardView.ts:378](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L378)

3. Board rendering, swimlane grouping, and drag-and-drop behavior live in one class.
   - `renderColumns()`, `renderSwimlane()`, `renderTaskCard()`, `groupTasksByParent()`, and `getParentProgress()` mix DOM creation, derived grouping rules, and DnD behavior.
   - References:
     - [TaskBoardView.ts:470](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L470)
     - [TaskBoardView.ts:523](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L523)
     - [TaskBoardView.ts:584](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L584)
     - [TaskBoardView.ts:722](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L722)
     - [TaskBoardView.ts:800](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L800)

4. Edit-modal composition and save orchestration are mixed with view behavior.
   - `openEditModal()` and `saveTaskChanges()` own DTO shaping, modal option building, task updates, move semantics, link syncing, reload/render behavior, and notices.
   - References:
     - [TaskBoardView.ts:819](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L819)
     - [TaskBoardView.ts:872](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L872)

5. Event sync policy and optimistic status updates are mixed into UI code.
   - `handleTaskStatusDrop()`, `handleTaskBoardEvent()`, and `syncFromEvent()` combine optimistic mutation, event deferral, modal/drag gating, and reload strategy.
   - References:
     - [TaskBoardView.ts:925](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L925)
     - [TaskBoardView.ts:950](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L950)
     - [TaskBoardView.ts:971](/Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp/.worktrees/taskboard-analysis/src/ui/tasks/TaskBoardView.ts#L971)

### Recommended extraction order

1. Extract `TaskBoardDataController`
   - Own `initializeView()`, `ensureServices()`, `loadBoardData()`, and filter validation inputs.
   - Goal: keep `TaskBoardView` from owning service bootstrap and workspace/project/task aggregation.

2. Extract `TaskBoardFilterController`
   - Own filter normalization, toolbar option lists, project dropdown refresh, filtered task stats, and `getFilteredAndSortedTasks()`.
   - Goal: isolate filter state transitions and derived lists from DOM rendering.

3. Extract `TaskBoardGroupingService`
   - Own `groupTasksByParent()` and `getParentProgress()`.
   - Goal: make swimlane grouping testable without view rendering.

4. Extract `TaskBoardRenderer`
   - Own `renderColumns()`, `renderSwimlane()`, `renderTaskCard()`, and drag/drop wiring callbacks.
   - Goal: make `TaskBoardView` the composition root rather than the full renderer.

5. Extract `TaskBoardEditCoordinator`
   - Own modal DTO construction, `TaskBoardEditModal` setup, task-save orchestration, project/parent move logic, note-link sync, and save notices.
   - Goal: separate task-edit workflows from the board shell.

6. Extract `TaskBoardSyncCoordinator`
   - Own `handleTaskBoardEvent()`, `syncFromEvent()`, and deferred-event behavior during drag/modal activity.
   - Goal: make sync policy explicit and testable.

### PR-sized batches

#### Batch 1: Data + filters

- Extract `TaskBoardDataController`
- Extract `TaskBoardFilterController`
- Add direct unit tests for:
  - workspace/project filter normalization
  - task filtering and sorting
  - project dropdown option derivation

#### Batch 2: Grouping + renderer

- Extract `TaskBoardGroupingService` ✅
- Extract `TaskBoardRenderer` ✅
- Add tests for:
  - swimlane grouping rules ✅
  - parent progress calculation ✅
  - renderer callback behavior via shallow DOM tests

#### Batch 3: Edit + sync workflows

- Extract `TaskBoardEditCoordinator` ✅
- Extract `TaskBoardSyncCoordinator` ✅
- Add tests for:
  - optimistic status update rollback ✅
  - pending event deferral during drag/edit ✅
  - note-link add/remove sync ✅

### Definition of done

- `TaskBoardView.ts` is primarily lifecycle/composition code
- grouping/filtering logic is unit-tested without needing the full ItemView
- modal save and event sync logic are moved out of the main view
- no regressions in drag/drop, modal save, or event refresh behavior

### Notes

- There is no existing `TaskBoardView` unit test file in `tests/unit`.
- `TaskBoardView` is now below the threshold. Remaining risk is mostly behavioral: drag/drop, note-link open, and toolbar interactions still need manual Obsidian verification after merge.
