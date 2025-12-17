#!/usr/bin/env node

/**
 * Automated refactoring script to rename MemoryManager modes to tools
 *
 * This script:
 * 1. Renames the modes directory to tools using git mv
 * 2. Renames all mode files to tool files using git mv
 * 3. Updates file contents (imports, class names, extends clauses)
 * 4. Updates memoryManager.ts imports and registrations
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;
const BASE_PATH = path.join(PROJECT_ROOT, 'src/agents/memoryManager');

console.log('='.repeat(80));
console.log('MemoryManager Mode-to-Tool Refactoring Script');
console.log('='.repeat(80));
console.log('');

// Helper function to execute git commands
function gitMv(from, to) {
    try {
        const cmd = `git mv "${from}" "${to}"`;
        console.log(`  Executing: ${cmd}`);
        execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit' });
        return true;
    } catch (error) {
        console.error(`  ERROR: Failed to rename ${from} → ${to}`);
        console.error(`  ${error.message}`);
        return false;
    }
}

// Helper function to update file content
function updateFileContent(filePath, updates) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');

        // Apply all updates
        for (const [from, to] of Object.entries(updates)) {
            content = content.replace(new RegExp(from, 'g'), to);
        }

        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`  ✓ Updated: ${path.relative(PROJECT_ROOT, filePath)}`);
        return true;
    } catch (error) {
        console.error(`  ✗ Failed to update: ${path.relative(PROJECT_ROOT, filePath)}`);
        console.error(`    ${error.message}`);
        return false;
    }
}

// Step 1: Rename directory
console.log('STEP 1: Renaming modes/ directory to tools/');
console.log('-'.repeat(80));
const modesPath = path.join(BASE_PATH, 'modes');
const toolsPath = path.join(BASE_PATH, 'tools');

if (fs.existsSync(toolsPath)) {
    console.log('  ⚠  tools/ directory already exists, skipping directory rename');
} else if (fs.existsSync(modesPath)) {
    gitMv(modesPath, toolsPath);
    console.log('  ✓ Directory renamed: modes/ → tools/');
} else {
    console.error('  ✗ ERROR: modes/ directory not found!');
    process.exit(1);
}
console.log('');

// Step 2: Rename files
console.log('STEP 2: Renaming mode files to tool files');
console.log('-'.repeat(80));

const fileRenames = [
    // Sessions
    ['tools/sessions/CreateSessionMode.ts', 'tools/sessions/CreateSessionTool.ts'],
    ['tools/sessions/ListSessionsMode.ts', 'tools/sessions/ListSessionsTool.ts'],
    ['tools/sessions/LoadSessionMode.ts', 'tools/sessions/LoadSessionTool.ts'],
    ['tools/sessions/UpdateSessionMode.ts', 'tools/sessions/UpdateSessionTool.ts'],

    // States
    ['tools/states/CreateStateMode.ts', 'tools/states/CreateStateTool.ts'],
    ['tools/states/ListStatesMode.ts', 'tools/states/ListStatesTool.ts'],
    ['tools/states/LoadStateMode.ts', 'tools/states/LoadStateTool.ts'],
    ['tools/states/UpdateStateMode.ts', 'tools/states/UpdateStateTool.ts'],

    // Workspaces
    ['tools/workspaces/CreateWorkspaceMode.ts', 'tools/workspaces/CreateWorkspaceTool.ts'],
    ['tools/workspaces/ListWorkspacesMode.ts', 'tools/workspaces/ListWorkspacesTool.ts'],
    ['tools/workspaces/LoadWorkspaceMode.ts', 'tools/workspaces/LoadWorkspaceTool.ts'],
    ['tools/workspaces/UpdateWorkspaceMode.ts', 'tools/workspaces/UpdateWorkspaceTool.ts'],
];

let renameSuccess = true;
for (const [from, to] of fileRenames) {
    const fromPath = path.join(BASE_PATH, from);
    const toPath = path.join(BASE_PATH, to);

    if (fs.existsSync(toPath)) {
        console.log(`  ⚠  ${to} already exists, skipping`);
    } else if (fs.existsSync(fromPath)) {
        if (!gitMv(fromPath, toPath)) {
            renameSuccess = false;
        }
    } else {
        console.log(`  ⚠  ${from} not found, skipping`);
    }
}

if (!renameSuccess) {
    console.error('  ✗ Some file renames failed. Please fix errors and re-run.');
    process.exit(1);
}
console.log('');

// Step 3: Update file contents
console.log('STEP 3: Updating file contents (imports, class names, extends)');
console.log('-'.repeat(80));

const toolFiles = [
    // Sessions
    'tools/sessions/CreateSessionTool.ts',
    'tools/sessions/ListSessionsTool.ts',
    'tools/sessions/LoadSessionTool.ts',
    'tools/sessions/UpdateSessionTool.ts',

    // States
    'tools/states/CreateStateTool.ts',
    'tools/states/ListStatesTool.ts',
    'tools/states/LoadStateTool.ts',
    'tools/states/UpdateStateTool.ts',

    // Workspaces
    'tools/workspaces/CreateWorkspaceTool.ts',
    'tools/workspaces/ListWorkspacesTool.ts',
    'tools/workspaces/LoadWorkspaceTool.ts',
    'tools/workspaces/UpdateWorkspaceTool.ts',
];

const contentUpdates = {
    // Import statements
    "import \\{ BaseMode \\} from '\\.\\./\\.\\./\\.\\./baseMode'": "import { BaseTool } from '../../../baseTool'",
    "import \\{ BaseMode \\} from '\\.\\.\\./baseMode'": "import { BaseTool } from '../baseTool'",

    // Extends clause
    'extends BaseMode': 'extends BaseTool',

    // Class names (in order to avoid partial replacements)
    'CreateSessionMode': 'CreateSessionTool',
    'ListSessionsMode': 'ListSessionsTool',
    'LoadSessionMode': 'LoadSessionTool',
    'UpdateSessionMode': 'UpdateSessionTool',
    'CreateStateMode': 'CreateStateTool',
    'ListStatesMode': 'ListStatesTool',
    'LoadStateMode': 'LoadStateTool',
    'UpdateStateMode': 'UpdateStateTool',
    'CreateWorkspaceMode': 'CreateWorkspaceTool',
    'ListWorkspacesMode': 'ListWorkspacesTool',
    'LoadWorkspaceMode': 'LoadWorkspaceTool',
    'UpdateWorkspaceMode': 'UpdateWorkspaceTool',

    // Comment updates (some common patterns)
    'Mode for': 'Tool for',
    'Mode to': 'Tool to',
    '\\* Mode ': '* Tool ',
    'session mode': 'session tool',
    'state mode': 'state tool',
    'workspace mode': 'workspace tool',
    'modes\\/': 'tools/',
};

let updateSuccess = true;
for (const file of toolFiles) {
    const filePath = path.join(BASE_PATH, file);
    if (fs.existsSync(filePath)) {
        if (!updateFileContent(filePath, contentUpdates)) {
            updateSuccess = false;
        }
    } else {
        console.log(`  ⚠  ${file} not found, skipping`);
    }
}

if (!updateSuccess) {
    console.error('  ✗ Some file content updates failed. Please review errors.');
}
console.log('');

// Step 4: Update memoryManager.ts
console.log('STEP 4: Updating memoryManager.ts');
console.log('-'.repeat(80));

const memoryManagerPath = path.join(BASE_PATH, 'memoryManager.ts');
const memoryManagerUpdates = {
    // Import paths
    "from '\\./modes/sessions/CreateSessionMode'": "from './tools/sessions/CreateSessionTool'",
    "from '\\./modes/sessions/ListSessionsMode'": "from './tools/sessions/ListSessionsTool'",
    "from '\\./modes/sessions/LoadSessionMode'": "from './tools/sessions/LoadSessionTool'",
    "from '\\./modes/sessions/UpdateSessionMode'": "from './tools/sessions/UpdateSessionTool'",
    "from '\\./modes/states/CreateStateMode'": "from './tools/states/CreateStateTool'",
    "from '\\./modes/states/ListStatesMode'": "from './tools/states/ListStatesTool'",
    "from '\\./modes/states/LoadStateMode'": "from './tools/states/LoadStateTool'",
    "from '\\./modes/states/UpdateStateMode'": "from './tools/states/UpdateStateTool'",
    "from '\\./modes/workspaces/CreateWorkspaceMode'": "from './tools/workspaces/CreateWorkspaceTool'",
    "from '\\./modes/workspaces/ListWorkspacesMode'": "from './tools/workspaces/ListWorkspacesTool'",
    "from '\\./modes/workspaces/LoadWorkspaceMode'": "from './tools/workspaces/LoadWorkspaceTool'",
    "from '\\./modes/workspaces/UpdateWorkspaceMode'": "from './tools/workspaces/UpdateWorkspaceTool'",

    // Plugin types import
    "from '\\./modes/utils/pluginTypes'": "from './tools/utils/pluginTypes'",

    // Class names in imports
    'CreateSessionMode': 'CreateSessionTool',
    'ListSessionsMode': 'ListSessionsTool',
    'LoadSessionMode': 'LoadSessionTool',
    'UpdateSessionMode': 'UpdateSessionTool',
    'CreateStateMode': 'CreateStateTool',
    'ListStatesMode': 'ListStatesTool',
    'LoadStateMode': 'LoadStateTool',
    'UpdateStateMode': 'UpdateStateTool',
    'CreateWorkspaceMode': 'CreateWorkspaceTool',
    'ListWorkspacesMode': 'ListWorkspacesTool',
    'LoadWorkspaceMode': 'LoadWorkspaceTool',
    'UpdateWorkspaceMode': 'UpdateWorkspaceTool',

    // Registration calls
    'this\\.registerMode\\(new (\\w+)Tool\\(this\\)\\)': 'this.registerTool(new $1Tool(this))',
    'this\\.registerMode\\(': 'this.registerTool(',

    // Comments
    'Register session modes': 'Register session tools',
    'Register state modes': 'Register state tools',
    'Register consolidated workspace modes': 'Register workspace tools',
    'mode for': 'tool for',
    'modes \\(': 'tools (',
};

if (fs.existsSync(memoryManagerPath)) {
    updateFileContent(memoryManagerPath, memoryManagerUpdates);
} else {
    console.error('  ✗ memoryManager.ts not found!');
}
console.log('');

// Final summary
console.log('='.repeat(80));
console.log('REFACTORING COMPLETE');
console.log('='.repeat(80));
console.log('');
console.log('Next steps:');
console.log('  1. Review the changes with: git status');
console.log('  2. Build the project: npm run build');
console.log('  3. Test the changes');
console.log('  4. Commit if everything works: git add . && git commit -m "refactor: rename MemoryManager modes to tools"');
console.log('');
