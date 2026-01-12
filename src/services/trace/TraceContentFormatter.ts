/**
 * Location: src/services/trace/TraceContentFormatter.ts
 *
 * Formats tool call traces into human-readable activity descriptions.
 * Single Responsibility: Only handles mapping tool operations to friendly text.
 */

interface TraceFormatParams {
  agent: string;
  mode: string;
  params: any;
  success: boolean;
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
  createPrompt: { success: 'Created prompt', failure: 'Failed to create prompt' },
  getPrompt: { success: 'Got prompt', failure: 'Failed to get prompt' },
  listPrompts: { success: 'Listed prompts', failure: 'Failed to list prompts' },
  updatePrompt: { success: 'Updated prompt', failure: 'Failed to update prompt' },
  archivePrompt: { success: 'Archived prompt', failure: 'Failed to archive prompt' },
  executePrompts: { success: 'Executed prompt', failure: 'Failed to execute prompt' },
  generateImage: { success: 'Generated image', failure: 'Failed to generate image' },
  listModels: { success: 'Listed models', failure: 'Failed to list models' },
  subagent: { success: 'Ran subagent', failure: 'Subagent failed' },

  // === searchManager ===
  searchContent: { success: 'Searched content', failure: 'Content search failed' },
  searchDirectory: { success: 'Searched directory', failure: 'Directory search failed' },
  searchMemory: { success: 'Searched memory', failure: 'Memory search failed' },

  // === storageManager ===
  archive: { success: 'Archived', failure: 'Failed to archive' },
  baseDirectory: { success: 'Set base directory', failure: 'Failed to set base directory' },
  copy: { success: 'Copied', failure: 'Failed to copy' },
  createFolder: { success: 'Created folder', failure: 'Failed to create folder' },
  move: { success: 'Moved', failure: 'Failed to move' },
  open: { success: 'Opened', failure: 'Failed to open' },

  // === toolManager ===
  getTools: { success: 'Got tools', failure: 'Failed to get tools' },
  useTools: { success: 'Used tool', failure: 'Tool execution failed' },
};

/**
 * Format a tool call into a human-readable activity description
 */
export function formatTraceContent({ agent, mode, params, success }: TraceFormatParams): string {
  const filePath = params?.filePath || params?.path || params?.params?.filePath;
  const query = params?.query || params?.params?.query;
  const id = params?.id || params?.params?.id;
  const name = params?.name || params?.params?.name;

  const verbs = modeVerbs[mode] || { success: 'Executed', failure: 'Failed' };
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
