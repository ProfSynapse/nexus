# MemoryManager Mode-to-Tool Refactoring Guide

## Overview
This document describes the complete refactoring needed to rename MemoryManager modes to tools, following the pattern where `IMode` → `ITool` and `BaseMode` → `BaseTool`.

## Step 1: Directory and File Renaming

### Directory Rename
```bash
git mv src/agents/memoryManager/modes src/agents/memoryManager/tools
```

### Session Files
```bash
git mv src/agents/memoryManager/tools/sessions/CreateSessionMode.ts src/agents/memoryManager/tools/sessions/CreateSessionTool.ts
git mv src/agents/memoryManager/tools/sessions/ListSessionsMode.ts src/agents/memoryManager/tools/sessions/ListSessionsTool.ts
git mv src/agents/memoryManager/tools/sessions/LoadSessionMode.ts src/agents/memoryManager/tools/sessions/LoadSessionTool.ts
git mv src/agents/memoryManager/tools/sessions/UpdateSessionMode.ts src/agents/memoryManager/tools/sessions/UpdateSessionTool.ts
```

### State Files
```bash
git mv src/agents/memoryManager/tools/states/CreateStateMode.ts src/agents/memoryManager/tools/states/CreateStateTool.ts
git mv src/agents/memoryManager/tools/states/ListStatesMode.ts src/agents/memoryManager/tools/states/ListStatesTool.ts
git mv src/agents/memoryManager/tools/states/LoadStateMode.ts src/agents/memoryManager/tools/states/LoadStateTool.ts
git mv src/agents/memoryManager/tools/states/UpdateStateMode.ts src/agents/memoryManager/tools/states/UpdateStateTool.ts
```

### Workspace Files
```bash
git mv src/agents/memoryManager/tools/workspaces/CreateWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/CreateWorkspaceTool.ts
git mv src/agents/memoryManager/tools/workspaces/ListWorkspacesMode.ts src/agents/memoryManager/tools/workspaces/ListWorkspacesTool.ts
git mv src/agents/memoryManager/tools/workspaces/LoadWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/LoadWorkspaceTool.ts
git mv src/agents/memoryManager/tools/workspaces/UpdateWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/UpdateWorkspaceTool.ts
```

## Step 2: Update File Contents

For EACH file, make the following replacements:

### Import Statement
**Before:** `import { BaseMode } from '../../../baseMode';`
**After:** `import { BaseTool } from '../../../baseTool';`

### Class Declaration
Replace `extends BaseMode` with `extends BaseTool`

### Class Names
- CreateSessionMode → CreateSessionTool
- ListSessionsMode → ListSessionsTool
- LoadSessionMode → LoadSessionTool
- UpdateSessionMode → UpdateSessionTool
- CreateStateMode → CreateStateTool
- ListStatesMode → ListStatesTool
- LoadStateMode → LoadStateTool
- UpdateStateMode → UpdateStateTool
- CreateWorkspaceMode → CreateWorkspaceTool
- ListWorkspacesMode → ListWorkspacesTool
- LoadWorkspaceMode → LoadWorkspaceTool
- UpdateWorkspaceMode → UpdateWorkspaceTool

### Comments
Update comments that mention "mode" to say "tool" where appropriate:
- "mode for" → "tool for"
- "Mode to" → "Tool to"
- "...Mode - " → "...Tool - "

## Step 3: Update memoryManager.ts

### Import Statements
**Before:**
```typescript
import { CreateSessionMode } from './modes/sessions/CreateSessionMode';
import { ListSessionsMode } from './modes/sessions/ListSessionsMode';
// ... etc
```

**After:**
```typescript
import { CreateSessionTool } from './tools/sessions/CreateSessionTool';
import { ListSessionsTool } from './tools/sessions/ListSessionsTool';
// ... etc
```

### Constructor Registrations
**Before:**
```typescript
this.registerMode(new CreateSessionMode(this));
this.registerMode(new ListSessionsMode(this));
// ... etc
```

**After:**
```typescript
this.registerTool(new CreateSessionTool(this));
this.registerTool(new ListSessionsTool(this));
// ... etc
```

### Update pluginTypes.ts path reference
**Before:** `from './modes/utils/pluginTypes'`
**After:** `from './tools/utils/pluginTypes'`

## Step 4: Additional Files to Check

### Index Files
- `src/agents/memoryManager/tools/index.ts` (if exists)
- `src/agents/memoryManager/tools/workspaces/index.ts`

Update any exports or imports in these files to use the new names.

## Step 5: Build and Test

```bash
npm run build
```

Verify no TypeScript errors occur.

## Summary of Changes

**Files Renamed:** 12 mode files → tool files
**Directory Renamed:** 1 (modes → tools)
**Code Changes:**
- ~24 import statement updates
- ~12 class name changes
- ~12 `extends BaseMode` → `extends BaseTool` changes
- ~24 registration calls in memoryManager.ts
- Multiple comment updates

## Automated Script

Run the Node.js automation script:
```bash
node refactor-memory-manager.js
```

This script will:
1. Perform all git mv commands
2. Update all file contents
3. Update memoryManager.ts
4. Report any issues
