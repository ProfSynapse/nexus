# TaskManager Agent: PREPARE Phase Research

> Research for loadWorkspace integration and CacheableEntityType extension
> Date: 2026-03-08

---

## 1. loadWorkspace Integration Point

### Current Response Building Flow

**File**: `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`

The `LoadWorkspaceTool.execute()` method builds its response at **lines 171-203**. The result object is constructed as a plain object literal:

```typescript
const result = {
  success: true,
  data: {
    context: context,           // WorkspaceContextBuilder output
    workflows: workflows,       // WorkspaceContextBuilder output
    workspaceStructure: ...,    // WorkspaceFileCollector output
    recentFiles: ...,           // WorkspaceFileCollector output
    keyFiles: ...,              // WorkspaceContextBuilder output
    preferences: ...,           // WorkspaceContextBuilder output
    sessions: limitedSessions,  // WorkspaceDataFetcher output (paginated)
    states: limitedStates,      // WorkspaceDataFetcher output (paginated)
    ...(workspacePrompt && { prompt: workspacePrompt })  // Conditional spread
  },
  pagination: { sessions: {...}, states: {...} },
  workspaceContext: workspaceContext
};
```

### Exact Insertion Point for `taskSummary`

**Recommended insertion**: Line 182, alongside the existing conditional `prompt` spread. Use the same conditional spread pattern:

```typescript
...(taskSummary && { taskSummary })
```

This should be placed **after** the `prompt` spread (line 182) and **before** the closing brace of `data` (line 183).

### How to Obtain `taskSummary`

1. Import `TaskService` (or obtain it from the agent's dependency injection)
2. After loading the workspace (line 88-97), call:
   ```typescript
   const taskSummary = await taskService.getWorkspaceSummary(workspace.id);
   ```
3. Place this call alongside other data fetching (around lines 118-155), e.g. after `promptResolver.fetchWorkspacePrompt()`
4. The call must be guarded because TaskService may not exist yet (plugin upgrades, optional feature):
   ```typescript
   let taskSummary = null;
   try {
     const taskService = this.agent.getTaskService?.();
     if (taskService) {
       taskSummary = await taskService.getWorkspaceSummary(workspace.id);
     }
   } catch { /* TaskManager not initialized — skip */ }
   ```

### Type Changes Required

**File**: `src/database/types/workspace/ParameterTypes.ts` (lines 88-138)

The `LoadWorkspaceResult` interface needs a `taskSummary` field added to its `data` type. Note that the `prompt` field is already conditionally added at runtime but is NOT in the type definition either — this is an existing gap. Both should ideally be typed.

Add to the `data` type (around line 117, after `states`):

```typescript
taskSummary?: {
  projects: {
    total: number;
    active: number;
    items: Array<{ id: string; name: string; taskCount: number; status: string }>;
  };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    overdue: number;
    nextActions: Array<{ id: string; title: string; priority: string; projectName: string }>;
    recentlyCompleted: Array<{ id: string; title: string; completedAt: number }>;
  };
};
```

### Result Schema Changes

**File**: `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts` (lines 290-476)

The `getResultSchema()` method returns a JSON Schema for tool discovery. A `taskSummary` property should be added to `data.properties` (after `prompt`, around line 427). This is what MCP clients see.

### Services Involved (Composition Pattern)

The loadWorkspace tool uses 4 composed services:
- `WorkspaceDataFetcher` — sessions, states
- `WorkspacePromptResolver` — workspace prompts
- `WorkspaceContextBuilder` — context briefing, workflows, key files, preferences
- `WorkspaceFileCollector` — file structure, recent files

Task summary does NOT fit neatly into any of these services. It should be fetched directly from `TaskService` in the `execute()` method, following the same pattern as the prompt fetch (direct call, conditionally spread into result).

### Error Handling Concern

The `createErrorResult()` method (lines 232-254) returns a default data structure for error cases. The `taskSummary` field should NOT be included in error results (it's optional), so no changes needed to `createErrorResult()`.

---

## 2. CacheableEntityType Extension

### Current State

**File**: `src/database/repositories/base/BaseRepository.ts`

```typescript
// Line 36
export type CacheableEntityType = 'workspace' | 'session' | 'state' | 'conversation' | 'message';
```

**Guard function** (line 218-219):
```typescript
private isCacheableEntityType(type: string): type is CacheableEntityType {
    return ['workspace', 'session', 'state', 'conversation', 'message'].includes(type);
}
```

### How It's Used

The `invalidateCache()` method (lines 227-243) has two code paths:

1. **Cacheable types** (in the union): Uses `queryCache.invalidateByType(entityType)` or `queryCache.invalidateById(entityType, id)` — these are typed methods on QueryCache that accept the same literal union.
2. **Non-cacheable types** (NOT in the union): Falls back to pattern-based invalidation via `queryCache.invalidate(pattern)` — uses regex matching on cache keys.

### Existing Repositories and Their Entity Types

| Repository | entityType | In CacheableEntityType? | Cache Behavior |
|------------|-----------|------------------------|----------------|
| WorkspaceRepository | `'workspace'` | Yes | Type-specific |
| SessionRepository | `'session'` | Yes | Type-specific |
| StateRepository | `'state'` | Yes | Type-specific |
| ConversationRepository | `'conversation'` | Yes | Type-specific |
| MessageRepository | `'message'` | Yes | Type-specific |
| TraceRepository | `'trace'` | **No** | Pattern-based fallback |

**Key finding**: `TraceRepository` already uses a non-cacheable entity type (`'trace'`) and works correctly via the pattern-based fallback. This means adding `'project'` and `'task'` is **safe** regardless of approach — they could be added to the union OR left out (fallback works).

### Three Locations That Need Synchronized Updates

If adding `'project'` and `'task'` to the cacheable types:

1. **`BaseRepository.ts` line 36** — `CacheableEntityType` union:
   ```typescript
   export type CacheableEntityType = 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task';
   ```

2. **`BaseRepository.ts` line 219** — `isCacheableEntityType` guard array:
   ```typescript
   return ['workspace', 'session', 'state', 'conversation', 'message', 'project', 'task'].includes(type);
   ```

3. **`QueryCache.ts` lines 246 and 263-264** — `invalidateByType` and `invalidateById` method signatures:
   ```typescript
   invalidateByType(type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task'): number {
   // ...
   invalidateById(
     type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task',
     id: string
   ): number {
   ```

### New Static Helper Methods Needed on QueryCache

Following the existing pattern of static key generators:

```typescript
/**
 * Generate cache key for project queries.
 */
static projectKey(workspaceId: string, projectId?: string, queryType: string = 'get'): string {
    return projectId
        ? `project:${queryType}:${workspaceId}:${projectId}`
        : `project:${queryType}:${workspaceId}:all`;
}

/**
 * Generate cache key for task queries.
 */
static taskKey(projectId: string, taskId?: string, queryType: string = 'get'): string {
    return taskId
        ? `task:${queryType}:${projectId}:${taskId}`
        : `task:${queryType}:${projectId}:all`;
}
```

### Side Effects Analysis

**Will adding 'project' and 'task' break existing behavior?** No.

- The `invalidateByType` / `invalidateById` methods are pure pattern-based (`^type:` prefix regex). Adding new types doesn't change how existing types are matched.
- The `isCacheableEntityType` guard is a simple `.includes()` check. Adding items to the array doesn't affect checks for existing items.
- The `CacheableEntityType` union is only used as a type guard in `invalidateCache()`. Widening a union type is always backward-compatible — all existing values remain valid.
- No other code imports or depends on `CacheableEntityType` outside of `BaseRepository.ts` itself.

### Recommendation

**Add both 'project' and 'task' to the cacheable types.** The type-specific invalidation is cleaner and more predictable than pattern-based fallback. The `TraceRepository` precedent shows the fallback works, but there's no reason to use it when you can get the typed path. All three locations (union, guard, QueryCache signatures) must be updated together.

### Alternative: Skip CacheableEntityType Extension

If the coders prefer to keep changes minimal, they could simply NOT add 'project' and 'task' to the union. The repositories would then use the pattern-based fallback path (like `TraceRepository` does). This works but is less explicit.

**Trade-off**: Explicit typing (recommended) provides compile-time safety and auto-complete. Pattern fallback works but loses TypeScript's help.

---

## Summary of Findings

### loadWorkspace Integration

| Aspect | Finding |
|--------|---------|
| Insertion point | Line 182 of `loadWorkspace.ts`, after prompt spread |
| Pattern | Conditional spread: `...(taskSummary && { taskSummary })` |
| Data source | `TaskService.getWorkspaceSummary(workspaceId)` |
| Guard needed | Yes — `getTaskService?.()` with try-catch (service may not exist) |
| Type file | `ParameterTypes.ts` — add optional `taskSummary` to `LoadWorkspaceResult.data` |
| Schema file | `loadWorkspace.ts` `getResultSchema()` — add `taskSummary` property |
| Error result | No changes needed (field is optional) |

### CacheableEntityType Extension

| Aspect | Finding |
|--------|---------|
| Safety | Safe — widening union is backward-compatible |
| Files to change | `BaseRepository.ts` (2 spots), `QueryCache.ts` (2 method signatures) |
| New methods needed | `QueryCache.projectKey()`, `QueryCache.taskKey()` |
| Precedent for NOT adding | `TraceRepository` uses pattern fallback, works fine |
| Recommendation | Add to union for type safety; update all 3 sync points |

### Surprises / Issues for the Plan

1. **Type gap**: `LoadWorkspaceResult` type doesn't include the `prompt` field that is already conditionally added at runtime. The coder should either fix this alongside `taskSummary` or at minimum document it.
2. **TraceRepository precedent**: Shows that non-cacheable entity types work fine, reducing risk of the CacheableEntityType change.
3. **No `getTaskService()` method exists yet**: The `loadWorkspace` tool accesses services via `this.agent.getWorkspaceServiceAsync()`, `this.agent.getMemoryService()`, etc. A new accessor (`getTaskService()` or similar) must be added to the MemoryManagerAgent (or the plugin's service registry) for loadWorkspace to access TaskService.
