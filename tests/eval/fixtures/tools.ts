/**
 * tests/eval/fixtures/tools.ts — Tool definitions for eval scenarios.
 *
 * Provides realistic Nexus tool schemas matching the production tool format.
 * These are passed to the StreamingOrchestrator so the LLM knows what tools
 * are available. Mirrors the shapes from contentManager, storageManager,
 * and searchManager agents.
 */

import type { Tool } from '../../../src/services/llm/adapters/types';

/**
 * Nexus domain tool definitions — simplified versions of real agent tools.
 * These use the agent_tool naming convention (e.g., contentManager_read).
 *
 * INVARIANT: this list and DEFAULT_TOOL_CATALOG in fixtures/system-prompt.ts
 * describe the same surface. The catalog is what the production
 * SystemPromptBuilder tells the model exists; this list is what the executor
 * can resolve and what assertNoHallucinatedTools accepts. A command in one and
 * not the other is a trap — the model obeys its prompt and is graded as
 * hallucinating. `nexus-model-eval/scripts/check_advertised_tools.py` checks
 * the invariant; keep both files in step when adding or removing a command.
 */
export const NEXUS_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'contentManager_read',
      description: 'Read the content of a note file. Returns file content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
          startLine: { type: 'number', description: 'Start line (1-based). Use 1 for beginning.' },
          endLine: { type: 'number', description: 'End line (1-based, inclusive). Omit to read to end.' },
        },
        required: ['path', 'startLine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contentManager_write',
      description: 'Write content to a note file. Creates the file if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contentManager_insert',
      description: 'Insert content into a note file at a specific position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to update' },
          content: { type: 'string', description: 'Content to insert' },
          position: { type: 'string', description: 'Insertion position' },
          lineNumber: { type: 'number', description: 'Optional line number' },
        },
        required: ['path', 'content', 'position'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contentManager_replace',
      description: 'Replace text in a note file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to update' },
          search: { type: 'string', description: 'Text to find' },
          replace: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contentManager_setProperty',
      description: 'Set a frontmatter property on a note. Supports "replace" (default) and "merge" (array union with dedup) modes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note file' },
          property: { type: 'string', description: 'Frontmatter property name (e.g. "tags", "aliases", "status")' },
          value: { type: 'string', description: 'Value to set' },
          mode: { type: 'string', description: "How to apply the value: 'replace' (default) or 'merge'" },
        },
        required: ['path', 'property', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_move',
      description: 'Move a file or folder to a new location.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Current path of the file or folder' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['path', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_copy',
      description: 'Copy a file or folder to a new location.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Current path of the file or folder' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['path', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_archive',
      description: 'Archive a file or folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file or folder to archive' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_createFolder',
      description: 'Create a new folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the folder to create' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_list',
      description: 'List files and folders in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the directory to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storageManager_open',
      description: 'Open a file in the editor.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to open' },
          mode: { type: 'string', description: 'Where to open the file (tab, split, window, or current)' },
          focus: { type: 'boolean', description: 'Whether to focus the opened file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchManager_content',
      description: 'Search for notes containing specific content. Returns matching results with relevance scores.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query text' },
          limit: { type: 'number', description: 'Maximum number of results to return' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchManager_directory',
      description: 'Search for files and folders by path or name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Directory search query text' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths to search within' },
          searchType: { type: 'string', description: 'Search type filter' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchManager_memory',
      description: 'Search workspace memory for past conversations, tool execution history, and workspace state snapshots.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for. Natural language works best for conversations.' },
          memoryTypes: { type: 'array', items: { type: 'string' }, description: "Which memory to search ('conversations', 'traces', 'states')" },
          sessionName: { type: 'string', description: 'Human-readable session name to scope the search to' },
          limit: { type: 'number', description: 'Maximum number of results to return' },
        },
        required: ['query'],
      },
    },
  },
  // taskManager — advertised in DEFAULT_TOOL_CATALOG but never asserted by a
  // scenario. It stays because two scenario prompts say "todo list", which is a
  // real pull toward `task list` / `task create`; a model that takes that route
  // must be graded as picking the wrong tool, not as inventing one.
  {
    type: 'function',
    function: {
      name: 'taskManager_createProject',
      description: 'Create a new project within a workspace. Projects organize tasks and must have a unique name per workspace.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name (must be unique within the workspace)' },
          description: { type: 'string', description: 'Project description' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'taskManager_listProjects',
      description: 'List projects in a workspace. Use to discover projectIds for task operations.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by project status (active, completed, archived)' },
          pageSize: { type: 'number', description: 'Items per page' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'taskManager_create',
      description: 'Create a task within a project. Requires a projectId from create-project or list-projects.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to create the task in' },
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Task description' },
          priority: { type: 'string', description: 'Task priority (critical, high, medium, low)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        },
        required: ['projectId', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'taskManager_list',
      description: 'List tasks in a project with optional filters for status, priority and assignee.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID (from create-project or list-projects)' },
          status: { type: 'string', description: 'Filter by task status (todo, in_progress, done, cancelled)' },
          priority: { type: 'string', description: 'Filter by priority (critical, high, medium, low)' },
          pageSize: { type: 'number', description: 'Items per page' },
        },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'taskManager_update',
      description: 'Update task fields such as title, description, status and priority. Requires a taskId.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID or short taskRef to update' },
          title: { type: 'string', description: 'New task title' },
          status: { type: 'string', description: 'New task status (todo, in_progress, done, cancelled)' },
          priority: { type: 'string', description: 'New task priority (critical, high, medium, low)' },
        },
        required: ['taskId'],
      },
    },
  },
];

/**
 * Two-tool architecture: getTools + useTools (the actual MCP entry point).
 */
export const META_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'getTools',
      description: 'Discover available tools. Returns CLI-oriented metadata for one or more selectors.',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Workspace ID' },
          sessionId: { type: 'string', description: 'Session identifier' },
          memory: { type: 'string', description: 'Brief summary of the conversation so far' },
          goal: { type: 'string', description: 'Brief statement of the current objective' },
          constraints: { type: 'string', description: 'Optional rules or limits' },
          tool: {
            type: 'string',
            description: 'Selector string such as "--help", "content", or "content read, storage list"',
          },
        },
        required: ['workspaceId', 'sessionId', 'memory', 'goal', 'tool'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'useTools',
      description: 'Execute one or more CLI-style tool commands using top-level workspaceId, sessionId, memory, goal, optional constraints, and tool.',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Workspace ID' },
          sessionId: { type: 'string', description: 'Session identifier' },
          memory: { type: 'string', description: 'Brief summary of the conversation so far' },
          goal: { type: 'string', description: 'Brief statement of the current objective' },
          constraints: { type: 'string', description: 'Optional rules or limits' },
          tool: {
            type: 'string',
            description: 'CLI-style command string such as "content read --path notes/today.md, storage list notes"',
          },
        },
        required: ['workspaceId', 'sessionId', 'memory', 'goal', 'tool'],
      },
    },
  },
];

/**
 * Simple tools for basic tool-call testing (weather/time, like the existing integration tests).
 */
export const SIMPLE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a given city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current time in a given timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone (e.g., America/New_York)' },
        },
        required: ['timezone'],
      },
    },
  },
];
