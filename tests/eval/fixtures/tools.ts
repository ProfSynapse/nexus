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
