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
      name: 'searchManager_searchContent',
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
];

/**
 * Two-tool architecture: getTools + useTools (the actual MCP entry point).
 */
export const META_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'getTools',
      description: 'Discover available tools. Returns schemas for requested agents/tools.',
      parameters: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of agent names to get tools for (e.g., ["contentManager", "storageManager"])',
          },
        },
        required: ['agents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'useTools',
      description: 'Execute tools. Pass context and an array of tool calls.',
      parameters: {
        type: 'object',
        properties: {
          context: {
            type: 'object',
            description: 'Execution context with workspaceId, sessionId, memory, goal',
          },
          calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'Tool name (e.g., contentManager_read)' },
                params: { type: 'object', description: 'Tool parameters' },
              },
            },
            description: 'Array of tool calls to execute',
          },
        },
        required: ['context', 'calls'],
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
