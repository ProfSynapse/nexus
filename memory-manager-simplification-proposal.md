# MemoryManager Simplification Proposal

## Overview

This document outlines a simplification of the MemoryManager agent, reducing tool count by making sessions implicit, removing session scoping for states, and using auto-generated IDs with human-readable names.

---

## Problem Statement

### Current Issues

1. **Too many tools (12-13)** - Separate CRUD for workspaces, sessions, and states
2. **Explicit session management** - LLMs must create/load sessions before using states
3. **Redundant concepts** - Sessions are really just conversation context, already tracked
4. **Complex scoping** - Session vs workspace scoping adds unnecessary complexity
5. **Key-based states** - User-provided keys are error-prone; should use IDs like workspaces

### Current Tool Count

| Entity | Tools | Count |
|--------|-------|-------|
| Workspace | createWorkspace, listWorkspaces, loadWorkspace, updateWorkspace | 4 |
| Session | createSession, listSessions, loadSession, updateSession | 4 |
| State | createState, listStates, loadState, updateState, deleteState | 5 |
| **Total** | | **13** |

---

## Design Principles

### Implicit Sessions

Sessions become an **addressing mechanism** rather than an **entity to manage**:

- **Native Chat (Nexus)**: Session ID = Conversation ID (automatic)
- **Claude Desktop (MCP)**: Session ID passed in `context` object (as today)

The session concept doesn't go away - the session **tools** go away. The `context.sessionId` still flows through for tracing and context.

### Workspace-Level States (No Session Scoping)

All states are scoped to the **workspace level**:

- Any conversation in the workspace can access any state
- No `scope` parameter needed
- Simpler mental model: workspace = container for all data
- Sessions are just conversation identifiers, not state boundaries

### Auto-Generated IDs + Human Names

States follow the same pattern as workspaces:

| Field | Description |
|-------|-------------|
| `id` | System-generated UUID (e.g., `state-abc123`) |
| `name` | Human-readable label, unique per workspace |

```typescript
// Create with human name
createState({ name: 'Project Goals', conversationContext: '...', activeTask: '...', ... })
// Returns: { success: true }

// Load by name (primary method)
loadState({ name: 'Project Goals' })
// Returns: { success: true, data: { name, conversationContext, activeTask, ... } }
```

### CRUA Pattern

| Operation | Description | Applies To |
|-----------|-------------|------------|
| **C**reate | Create new entity | Workspace, State |
| **R**ead | Load single / List multiple | Workspace, State |
| **U**pdate | Modify existing entity | Workspace only |
| **A**rchive | Soft delete (isArchived flag) | Workspace, State |

**Note**: States are immutable - no update operation.

### Lean Response Format

Write operations return minimal responses - the LLM already knows what it passed.

| Operation Type | Success Response | Error Response |
|----------------|------------------|----------------|
| Create/Update/Archive | `{ success: true }` | `{ success: false, error: 'Recovery-oriented message' }` |
| List | `{ success: true, data: [{ name, description }, ...] }` | `{ success: false, error: '...' }` |
| Load | `{ success: true, data: { ...fields } }` | `{ success: false, error: '...' }` |

**Error messages should guide recovery:**
- `'State "X" not found. Use listStates to see available states.'`
- `'State "X" already exists. Use a unique name like "X-v2".'`
- `'Workspace "X" not found. Use listWorkspaces to see available workspaces.'`

---

## Proposed Tool Set

### Workspace Tools (5)

| Tool | Purpose | CRUA |
|------|---------|------|
| `createWorkspace` | Create new workspace | C |
| `listWorkspaces` | List all workspaces | R |
| `loadWorkspace` | Load workspace context | R |
| `updateWorkspace` | Modify workspace | U |
| `archiveWorkspace` | Soft delete workspace | A |

### State Tools (4)

| Tool | Purpose | CRUA |
|------|---------|------|
| `createState` | Create new state | C |
| `listStates` | List states in workspace | R |
| `loadState` | Load state by name | R |
| `archiveState` | Soft delete state | A |

**States are sacrosanct:**
- Once created, a state cannot be modified
- No `updateState` exists - states are immutable historical snapshots
- `archiveState` hides it from lists but preserves the record
- Each state captures a moment in time, forever

### Total: 9 tools (down from 13, 31% reduction)

---

## Tool Specifications

### Workspace Tools

#### `createWorkspace`

Create a new workspace.

```typescript
createWorkspace({
  // Required fields
  name: string,              // Workspace name (required, unique)
  description: string,       // What this workspace is for (required)
  rootFolder: string,        // Vault folder to scope to (required)
  purpose: string,           // What this workspace is used for (required)
  // Optional context fields
  workflows?: string[],      // Common workflows
  keyFiles?: string[],       // Important files
  preferences?: Record<string, any>
})
```

**Note**: `currentGoal` has been removed entirely - goals are ephemeral and belong in session context.

**Returns:** `{ success: true }`

**Error:** `{ success: false, error: 'Workspace "X" already exists. Use listWorkspaces to see existing workspaces.' }`

#### `listWorkspaces`

List all workspaces.

```typescript
listWorkspaces({
  includeArchived?: boolean  // Include archived workspaces, default: false
})
```

**Returns:** `{ success: true, data: [{ name, description }, ...] }`

#### `loadWorkspace`

Load a workspace's full context.

```typescript
loadWorkspace({
  name: string               // Workspace name to load
})
```

**Returns:** `{ success: true, data: { name, description, rootFolder, purpose, workflows, keyFiles, ... } }`

**Error:** `{ success: false, error: 'Workspace "X" not found. Use listWorkspaces to see available workspaces.' }`

#### `updateWorkspace`

Update workspace fields.

```typescript
updateWorkspace({
  name: string,              // Workspace name to update (identifier)
  // Any fields to update (all optional)
  description?: string,
  rootFolder?: string,
  purpose?: string,
  workflows?: string[],
  keyFiles?: string[],
  preferences?: Record<string, any>
})
```

**Note**: `currentGoal` is not updatable - goals are ephemeral and belong in session context.

**Returns:** `{ success: true }`

**Error:** `{ success: false, error: 'Workspace "X" not found. Use listWorkspaces to see available workspaces.' }`

#### `archiveWorkspace`

Archive a workspace (soft delete).

```typescript
archiveWorkspace({
  name: string               // Workspace name to archive
})
```

**Returns:** `{ success: true }`

**Error:** `{ success: false, error: 'Workspace "X" not found. Use listWorkspaces to see available workspaces.' }`

**Behavior:**
- Sets `isArchived: true` on the workspace record
- Workspace no longer appears in `listWorkspaces()` by default
- Can be restored via `updateWorkspace({ name, isArchived: false })`

---

### State Tools

All state operations are scoped to the current workspace (from `context.workspaceId`).

#### `createState`

Create a new state in the current workspace. States are structured "save points" that capture context for later resumption.

```typescript
createState({
  // Required fields - the structured "save point"
  name: string,              // Human-readable name (unique per workspace)
  conversationContext: string, // What was happening when you decided to save
  activeTask: string,        // What task were you actively working on
  activeFiles: string[],     // Which files were you working with
  nextSteps: string[],       // Immediate next steps when resuming
  // Optional fields
  description?: string,      // Additional description
  tags?: string[]            // Tags for categorization
})
```

**Returns:** `{ success: true }`

**Error:** `{ success: false, error: 'State "X" already exists. States are immutable - use a unique name like "X-v2" or "X-2024-01".' }`

**Behavior:**
- Auto-generates UUID for `id` (internal)
- **Fails if state with same name already exists** (names are unique per workspace, forever)
- States are immutable snapshots - once created, they cannot be changed
- Stored at workspace level (not session-scoped)

#### `listStates`

List all states in current workspace.

```typescript
listStates({
  includeArchived?: boolean  // Default: false
})
```

**Returns:** `{ success: true, data: [{ name, description }, ...] }`

#### `loadState`

Load a state by name.

```typescript
loadState({
  name: string               // State name to load
})
```

**Returns:**
```typescript
{
  success: true,
  data: {
    name,
    conversationContext,
    activeTask,
    activeFiles,
    nextSteps,
    description?,
    tags?
  }
}
```

**Error:** `{ success: false, error: 'State "X" not found. Use listStates to see available states.' }`

#### `archiveState`

Archive a state (soft delete).

```typescript
archiveState({
  name: string               // State name to archive
})
```

**Returns:** `{ success: true }`

**Error:** `{ success: false, error: 'State "X" not found. Use listStates to see available states.' }`

**Behavior:**
- Sets `isArchived: true` on the state record
- State no longer appears in `listStates()` by default

---

## How Sessions Work Now

Sessions are **implicit** - they exist as conversation identifiers but have no dedicated tools.

### Native Chat (Nexus)

```
User opens conversation → Conversation ID becomes sessionId
                        → Auto-injected into context
                        → Used for tracing, not state scoping
```

### Claude Desktop (MCP)

```
Claude calls useTools → Passes context.sessionId (as today)
                     → Used for tracing and context
                     → No createSession needed
```

### What Happened to Session Tools?

| Old Tool | New Equivalent |
|----------|----------------|
| `createSession` | Automatic - sessionId comes from context |
| `loadSession` | N/A - session is the conversation itself |
| `listSessions` | N/A - not needed for state access |
| `updateSession` | N/A - session context is in the context block |

### Session Context (memory, goal, constraints)

Session-level context is passed in the `context` block with every tool call:

```typescript
useTools({
  context: {
    workspaceId: 'project-alpha',
    sessionId: 'conversation-123',
    memory: 'User is refactoring auth module...',  // Session memory
    goal: 'Complete OAuth integration',             // Session goal
    constraints: 'Must maintain backward compat'   // Session constraints
  },
  calls: [...]
})
```

This is already how it works - no changes needed.

---

## Example Flows

### Flow 1: Project Setup

```typescript
// 1. Create a workspace for the project
useTools({
  context: { workspaceId: 'default', sessionId: 'setup', memory: '', goal: 'Setup project' },
  calls: [{
    agent: 'memoryManager',
    tool: 'createWorkspace',
    params: {
      name: 'Project Alpha',
      description: 'E-commerce platform rebuild',
      rootFolder: 'projects/alpha',
      purpose: 'Rebuild legacy e-commerce platform'
    }
  }]
})
// Returns: { success: true }
```

### Flow 2: Saving State (Structured Save Point)

```typescript
// 2. Save current work context as a state
useTools({
  context: { workspaceId: 'ws-abc123', sessionId: 'session-1', ... },
  calls: [{
    agent: 'memoryManager',
    tool: 'createState',
    params: {
      name: 'Auth Module Progress',
      conversationContext: 'We decided on JWT tokens for auth and set up the basic structure.',
      activeTask: 'Implementing token refresh logic',
      activeFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
      nextSteps: ['Add refresh token endpoint', 'Test token expiration', 'Add logout flow'],
      tags: ['auth', 'in-progress']
    }
  }]
})
// Returns: { success: true }
```

### Flow 3: Loading State (Different Conversation)

```typescript
// 3. Later, in a different conversation, resume work
useTools({
  context: { workspaceId: 'ws-abc123', sessionId: 'session-2', ... },
  calls: [{
    agent: 'memoryManager',
    tool: 'loadState',
    params: { name: 'Auth Module Progress' }
  }]
})
// Returns: { success: true, data: { name: 'Auth Module Progress', conversationContext: '...', activeTask: '...', ... } }
```

---

## Summary of Changes

### Tool Count Reduction

| Before | After | Reduction |
|--------|-------|-----------|
| 13 tools | 9 tools | **-31%** |

### Tools Removed

| Removed | Reason |
|---------|--------|
| `createSession` | Sessions are implicit from context |
| `loadSession` | Session = conversation, no loading needed |
| `listSessions` | Not needed - states are workspace-scoped |
| `updateSession` | Session context is in the context block |
| `updateState` | States are immutable snapshots |
| `deleteState` | Replaced by `archiveState` (soft delete) |

### Conceptual Simplification

| Before | After |
|--------|-------|
| 3 entity types (Workspace, Session, State) | 2 entity types (Workspace, State) |
| Explicit session management | Implicit sessions from context |
| Session-scoped states | Workspace-scoped states (simpler) |
| Mutable states | Immutable states (sacrosanct) |
| Permanent delete | Archive pattern (recoverable) |
| Key-based states | Name-based with auto-generated IDs |

---

## Migration Path

### Phase 1: Add Archive Support
1. Add `isArchived` field to workspace and state schemas
2. Implement `archiveWorkspace` and `archiveState` tools
3. Update `list` tools to filter archived by default

### Phase 2: Update State Model
1. Change states to workspace-scoped (remove session scoping)
2. Change from `key` to `name` with auto-generated `id`
3. Make states immutable (remove update capability)

### Phase 3: Remove Session Tools
1. Remove `createSession`, `loadSession`, `listSessions`, `updateSession`
2. Remove `updateState`
3. Update tool registrations

### Phase 4: Testing
1. Test Native Chat flow (implicit sessions)
2. Test Claude Desktop flow (explicit context.sessionId)
3. Test immutable state behavior
4. Test archive workflow

---

## Impact on SearchManager

### `searchMemory` Simplification

The `searchMemory` tool in SearchManager should be updated to align with this simplification.

**Current memoryTypes:**
```typescript
memoryTypes: ['traces', 'toolCalls', 'sessions', 'states', 'workspaces']
```

**Simplified memoryTypes:**
```typescript
memoryTypes: ['states', 'traces']
```

| Type | What It Searches |
|------|------------------|
| `states` | Immutable state snapshots created via `createState` |
| `traces` | Tool call history (what tools were called, with what params/results) |

**Key Changes:**
1. Always scoped to `workspaceId` (required parameter)
2. Remove `sessions` as searchable type (sessions are implicit, not entities)
3. Remove `workspaces` as searchable type (use `listWorkspaces` instead)
4. Merge `traces` and `toolCalls` into just `traces`

**Simplified Schema:**
```typescript
searchMemory({
  query: string,           // Search terms (required)
  workspaceId: string,     // Workspace scope (required)
  memoryTypes?: ['states' | 'traces'],  // What to search, default: both
  dateRange?: { start?, end? },
  limit?: number
})
```

**Returns:** `{ success: true, data: [{ content, type, tool?, context? }, ...] }`

---

## Appendix: Full Tool Reference

### MemoryManager (9 tools)

```typescript
// Workspace operations (5 tools)
createWorkspace({ name, description, rootFolder, purpose, workflows?, keyFiles?, preferences? })
listWorkspaces({ includeArchived? })
loadWorkspace({ name })
updateWorkspace({ name, description?, rootFolder?, purpose?, workflows?, keyFiles?, preferences? })
archiveWorkspace({ name })

// State operations (4 tools) - workspace-scoped via context.workspaceId
createState({ name, conversationContext, activeTask, activeFiles, nextSteps, description?, tags? })
listStates({ includeArchived? })
loadState({ name })
archiveState({ name })
```

---

## Implementation Notes

### Storage Layer Changes

1. **Session ID for States**: Use constant `'_workspace'` as sessionId for all state operations
   - `IStorageAdapter.getStates()` already has sessionId as optional
   - Pass `'_workspace'` to MemoryService methods that require sessionId

2. **isArchived Field**: Add to types and storage
   - `HybridStorageTypes.StateMetadata.isArchived?: boolean`
   - `HybridStorageTypes.WorkspaceMetadata.isArchived?: boolean`
   - Update list queries to filter `isArchived !== true` by default

3. **State Name Uniqueness**: Add check in createState
   - Query existing states by name before creating
   - Return error if name already exists in workspace

### Files to Modify

**Types:**
- `src/types/storage/HybridStorageTypes.ts` - Add isArchived, remove currentGoal
- `src/database/types/workspace/WorkspaceTypes.ts` - Remove currentGoal from WorkspaceContext
- `src/database/types/session/SessionTypes.ts` - Remove reasoning from StateContext
- `src/agents/memoryManager/types.ts` - Update params/result types

**Tools to Remove:**
- `src/agents/memoryManager/tools/sessions/` - All 4 session tools
- `src/agents/memoryManager/tools/states/UpdateState.ts`

**Tools to Add:**
- `src/agents/memoryManager/tools/workspaces/ArchiveWorkspace.ts`
- `src/agents/memoryManager/tools/states/ArchiveState.ts`

**Tools to Modify:**
- `CreateWorkspace.ts` - Make description, rootFolder, purpose required; remove currentGoal
- `UpdateWorkspace.ts` - Remove currentGoal
- `CreateState.ts` - Remove reasoning, add uniqueness check, use '_workspace' sessionId
- `ListStates.ts` - Add includeArchived, remove session scoping
- `LoadState.ts` - Change param from stateId to name, simplify output
- `ListWorkspaces.ts` - Add includeArchived

**Agent Registration:**
- `src/agents/memoryManager/memoryManager.ts` - Update tool registrations

**Other:**
- `src/services/chat/DirectToolExecutor.ts` - Remove session tool suggestions
- `src/agents/searchManager/tools/searchMemory.ts` - Simplify memoryTypes
