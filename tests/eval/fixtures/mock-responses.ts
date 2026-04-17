/**
 * tests/eval/fixtures/mock-responses.ts — Realistic mock tool responses.
 *
 * These match the shapes returned by actual Nexus agent tools. Used by
 * YAML scenarios via the mockResponses field. Also available for programmatic
 * scenario construction.
 */

import type { MockToolResponse } from '../types';

// ---------------------------------------------------------------------------
// ContentManager responses
// ---------------------------------------------------------------------------

export const READ_NOTE_SUCCESS: MockToolResponse = {
  success: true,
  result: {
    content: '1: # Q2 Meeting Notes\n2: \n3: - Roadmap reviewed\n4: - Budget approved\n5: - Launch date: June 15\n6: - Action items assigned',
    path: 'notes/meeting.md',
    totalLines: 6,
    startLine: 1,
    endLine: 6,
  },
};

export const WRITE_NOTE_SUCCESS: MockToolResponse = {
  success: true,
  result: {
    path: 'notes/summary.md',
    created: true,
  },
};

export const READ_NONEXISTENT: MockToolResponse = {
  success: false,
  error: 'File not found: notes/nonexistent.md',
};

// ---------------------------------------------------------------------------
// StorageManager responses
// ---------------------------------------------------------------------------

export const MOVE_FILE_SUCCESS: MockToolResponse = {
  success: true,
  result: {
    newPath: 'archive/summary.md',
    originalPath: 'notes/summary.md',
  },
};

export const LIST_DIRECTORY_SUCCESS: MockToolResponse = {
  success: true,
  result: {
    path: 'notes/',
    files: [
      { name: 'meeting.md', type: 'file' },
      { name: 'roadmap-q2.md', type: 'file' },
      { name: 'summary.md', type: 'file' },
    ],
    folders: [
      { name: 'archive', type: 'folder' },
    ],
  },
};

// ---------------------------------------------------------------------------
// SearchManager responses
// ---------------------------------------------------------------------------

export const SEARCH_RESULTS_SUCCESS: MockToolResponse = {
  success: true,
  result: {
    results: [
      {
        path: 'notes/roadmap-q2.md',
        score: 0.95,
        snippet: 'Q2 roadmap priorities: mobile launch, plugin store, performance...',
      },
      {
        path: 'notes/meeting.md',
        score: 0.72,
        snippet: 'Roadmap reviewed during Q2 meeting...',
      },
    ],
    totalResults: 2,
    query: 'project roadmap',
  },
};

export const SEARCH_NO_RESULTS: MockToolResponse = {
  success: true,
  result: {
    results: [],
    totalResults: 0,
    query: 'nonexistent topic xyz',
  },
};

// ---------------------------------------------------------------------------
// Two-tool architecture responses (getTools / useTools)
// ---------------------------------------------------------------------------

export const GET_TOOLS_RESPONSE: MockToolResponse = {
  success: true,
  result: {
    tools: [
      {
        agent: 'contentManager',
        tool: 'read',
        description: 'Read the content of a note file.',
        command: 'content read',
        usage: 'content read <path> <startLine> [--end-line <endLine>]',
        arguments: [
          { name: 'path', flag: '--path', type: 'string', required: true, positional: true },
          { name: 'startLine', flag: '--start-line', type: 'number', required: true, positional: true },
          { name: 'endLine', flag: '--end-line', type: 'number', required: false, positional: false },
        ],
        examples: ['content read "notes/meeting.md" 1 --end-line 20'],
      },
      {
        agent: 'contentManager',
        tool: 'write',
        description: 'Write content to a note file.',
        command: 'content write',
        usage: 'content write <path> <content>',
        arguments: [
          { name: 'path', flag: '--path', type: 'string', required: true, positional: true },
          { name: 'content', flag: '--content', type: 'string', required: true, positional: true },
        ],
        examples: ['content write "notes/summary.md" "# Summary"'],
      },
    ],
  },
};

export const USE_TOOLS_READ_RESPONSE: MockToolResponse = {
  success: true,
  result: {
    results: [
      {
        tool: 'contentManager_read',
        success: true,
        result: {
          content: '# Meeting Notes\n\n- Discussed roadmap\n- Budget approved',
          path: 'notes/meeting.md',
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Simple tool responses (weather/time — for basic scenarios)
// ---------------------------------------------------------------------------

export const WEATHER_RESPONSE: MockToolResponse = {
  success: true,
  result: {
    city: 'San Francisco',
    temperature: 72,
    unit: 'F',
    condition: 'sunny',
  },
};

export const TIME_RESPONSE: MockToolResponse = {
  success: true,
  result: {
    timezone: 'America/New_York',
    time: '2026-04-15T12:00:00-04:00',
  },
};

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

export const TOOL_ERROR_RESPONSE: MockToolResponse = {
  success: false,
  error: 'Permission denied: cannot access protected file',
};

export const TOOL_TIMEOUT_RESPONSE: MockToolResponse = {
  success: false,
  error: 'Tool execution timed out after 30000ms',
};
