/**
 * Location: src/services/trace/TraceContentFormatter.ts
 *
 * Formats tool call traces into human-readable activity descriptions.
 * Single Responsibility: Only handles mapping tool operations to friendly text.
 */

interface TraceFormatParams {
  agent: string;
  mode: string;
  params: unknown;
  success: boolean;
}

function isTraceParamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTraceString(params: unknown, ...path: string[]): string | undefined {
  let current: unknown = params;

  for (const segment of path) {
    if (!isTraceParamRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return typeof current === 'string' ? current : undefined;
}

const modeVerbs: Record<string, { success: string; failure: string }> = {
  // === contentManager ===
  read: { success: 'Read', failure: 'Failed to read' },
  write: { success: 'Wrote', failure: 'Failed to write' },
  update: { success: 'Updated', failure: 'Failed to update' },

  // === canvasManager ===
  // (uses read, write, update from above)
  list: { success: 'Listed', failure: 'Failed to list' },

  // === memoryManager/workspaces ===
  loadWorkspace: { success: 'Loaded workspace', failure: 'Failed to load workspace' },
  createWorkspace: { success: 'Created workspace', failure: 'Failed to create workspace' },
  listWorkspaces: { success: 'Listed workspaces', failure: 'Failed to list workspaces' },
  archiveWorkspace: { success: 'Archived workspace', failure: 'Failed to archive workspace' },
  updateWorkspace: { success: 'Updated workspace', failure: 'Failed to update workspace' },

  // === memoryManager/states ===
  createState: { success: 'Saved state', failure: 'Failed to save state' },
  listStates: { success: 'Listed states', failure: 'Failed to list states' },
  loadState: { success: 'Loaded state', failure: 'Failed to load state' },

  // === promptManager ===
  promptManager_create: { success: 'Created prompt', failure: 'Failed to create prompt' },
  promptManager_get: { success: 'Got prompt', failure: 'Failed to get prompt' },
  promptManager_list: { success: 'Listed prompts', failure: 'Failed to list prompts' },
  promptManager_update: { success: 'Updated prompt', failure: 'Failed to update prompt' },
  promptManager_archive: { success: 'Archived prompt', failure: 'Failed to archive prompt' },
  promptManager_execute: { success: 'Executed prompt', failure: 'Failed to execute prompt' },
  generateImage: { success: 'Generated image', failure: 'Failed to generate image' },
  listModels: { success: 'Listed models', failure: 'Failed to list models' },
  subagent: { success: 'Ran subagent', failure: 'Subagent failed' },

  // === searchManager ===
  searchManager_content: { success: 'Searched content', failure: 'Content search failed' },
  searchManager_directory: { success: 'Searched directory', failure: 'Directory search failed' },
  searchManager_memory: { success: 'Searched memory', failure: 'Memory search failed' },

  // === storageManager ===
  archive: { success: 'Archived', failure: 'Failed to archive' },
  baseDirectory: { success: 'Set base directory', failure: 'Failed to set base directory' },
  copy: { success: 'Copied', failure: 'Failed to copy' },
  createFolder: { success: 'Created folder', failure: 'Failed to create folder' },
  move: { success: 'Moved', failure: 'Failed to move' },
  open: { success: 'Opened', failure: 'Failed to open' },

  // === taskManager ===
  taskManager_create: { success: 'Created task', failure: 'Failed to create task' },
  taskManager_list: { success: 'Listed tasks', failure: 'Failed to list tasks' },
  taskManager_update: { success: 'Updated task', failure: 'Failed to update task' },
  taskManager_move: { success: 'Moved task', failure: 'Failed to move task' },
  taskManager_query: { success: 'Queried tasks', failure: 'Failed to query tasks' },
  taskManager_open: { success: 'Opened task board', failure: 'Failed to open task board' },
  createProject: { success: 'Created project', failure: 'Failed to create project' },
  listProjects: { success: 'Listed projects', failure: 'Failed to list projects' },
  updateProject: { success: 'Updated project', failure: 'Failed to update project' },
  archiveProject: { success: 'Archived project', failure: 'Failed to archive project' },
  linkNote: { success: 'Linked note', failure: 'Failed to link note' },

  // === ingestManager ===
  ingestManager_run: { success: 'Ingested file', failure: 'Failed to ingest file' },
  ingestManager_capabilities: { success: 'Listed ingest capabilities', failure: 'Failed to list ingest capabilities' },

  // === webTools ===
  webTools_open: { success: 'Opened webpage', failure: 'Failed to open webpage' },
  'webTools_capture-pdf': { success: 'Captured page PDF', failure: 'Failed to capture page PDF' },
  'webTools_capture-png': { success: 'Captured page PNG', failure: 'Failed to capture page PNG' },
  'webTools_capture-markdown': { success: 'Captured to markdown', failure: 'Failed to capture to markdown' },
  webTools_links: { success: 'Extracted links', failure: 'Failed to extract links' },

  // === memoryManager/workflows ===
  memoryManager_run: { success: 'Ran workflow', failure: 'Failed to run workflow' },

  // === toolManager ===
  getTools: { success: 'Got tools', failure: 'Failed to get tools' },
  useTools: { success: 'Used tool', failure: 'Tool execution failed' },
};

/**
 * Format a tool call into a human-readable activity description
 */
export function formatTraceContent({ agent, mode, params, success }: TraceFormatParams): string {
  const filePath = getTraceString(params, 'filePath') || getTraceString(params, 'path') || getTraceString(params, 'params', 'filePath');
  const query = getTraceString(params, 'query') || getTraceString(params, 'params', 'query');
  const id = getTraceString(params, 'id') || getTraceString(params, 'params', 'id');
  const name = getTraceString(params, 'name') || getTraceString(params, 'params', 'name');

  const verbs = modeVerbs[`${agent}_${mode}`] || modeVerbs[mode] || { success: 'Executed', failure: 'Failed' };
  const verb = success ? verbs.success : verbs.failure;

  // Build concise description based on available context
  if (filePath) {
    return `${verb} ${filePath}`;
  } else if (query) {
    const truncated = query.length > 30 ? `${query.slice(0, 30)}...` : query;
    return `${verb} for "${truncated}"`;
  } else if (name) {
    return `${verb} ${name}`;
  } else if (id) {
    return `${verb} ${id}`;
  }

  return verb;
}
