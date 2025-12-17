#!/bin/bash

# Script to rename MemoryManager modes to tools
# This script uses git mv for proper tracking of file renames

set -e  # Exit on error

echo "Starting MemoryManager mode-to-tool refactoring..."

# Navigate to project root
cd /Users/jrosenbaum/Documents/Code/.obsidian/plugins/claudesidian-mcp

# Step 1: Rename the modes directory to tools
echo "Step 1: Renaming modes/ directory to tools/..."
git mv src/agents/memoryManager/modes src/agents/memoryManager/tools

# Step 2: Rename session mode files to tool files
echo "Step 2: Renaming session mode files..."
git mv src/agents/memoryManager/tools/sessions/CreateSessionMode.ts src/agents/memoryManager/tools/sessions/CreateSessionTool.ts
git mv src/agents/memoryManager/tools/sessions/ListSessionsMode.ts src/agents/memoryManager/tools/sessions/ListSessionsTool.ts
git mv src/agents/memoryManager/tools/sessions/LoadSessionMode.ts src/agents/memoryManager/tools/sessions/LoadSessionTool.ts
git mv src/agents/memoryManager/tools/sessions/UpdateSessionMode.ts src/agents/memoryManager/tools/sessions/UpdateSessionTool.ts

# Step 3: Rename state mode files to tool files
echo "Step 3: Renaming state mode files..."
git mv src/agents/memoryManager/tools/states/CreateStateMode.ts src/agents/memoryManager/tools/states/CreateStateTool.ts
git mv src/agents/memoryManager/tools/states/ListStatesMode.ts src/agents/memoryManager/tools/states/ListStatesTool.ts
git mv src/agents/memoryManager/tools/states/LoadStateMode.ts src/agents/memoryManager/tools/states/LoadStateTool.ts
git mv src/agents/memoryManager/tools/states/UpdateStateMode.ts src/agents/memoryManager/tools/states/UpdateStateTool.ts

# Step 4: Rename workspace mode files to tool files
echo "Step 4: Renaming workspace mode files..."
git mv src/agents/memoryManager/tools/workspaces/CreateWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/CreateWorkspaceTool.ts
git mv src/agents/memoryManager/tools/workspaces/ListWorkspacesMode.ts src/agents/memoryManager/tools/workspaces/ListWorkspacesTool.ts
git mv src/agents/memoryManager/tools/workspaces/LoadWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/LoadWorkspaceTool.ts
git mv src/agents/memoryManager/tools/workspaces/UpdateWorkspaceMode.ts src/agents/memoryManager/tools/workspaces/UpdateWorkspaceTool.ts

echo "File renaming complete!"
echo ""
echo "Next steps:"
echo "1. Run the script to update file contents"
echo "2. Update memoryManager.ts imports"
echo "3. Build and test"
