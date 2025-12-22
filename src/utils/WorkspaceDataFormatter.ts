/**
 * WorkspaceDataFormatter - Shared utility for formatting workspace data
 *
 * Used by:
 * - SystemPromptBuilder (for chat system prompts)
 * - SubagentExecutor (for subagent system prompts)
 *
 * Extracts relevant fields from comprehensive workspace data and serializes to JSON.
 */

export interface FormattedWorkspaceData {
  context?: unknown;
  workflows?: unknown[];
  workspaceStructure?: unknown[];
  recentFiles?: unknown[];
  keyFiles?: Record<string, unknown>;
  preferences?: string;
  sessions?: unknown[];
  states?: unknown[];
}

export interface FormatOptions {
  /** Maximum number of states to include (default: all) */
  maxStates?: number;
  /** Maximum number of sessions to include (default: all) */
  maxSessions?: number;
  /** Whether to pretty-print JSON (default: true) */
  prettyPrint?: boolean;
}

/**
 * Extract relevant fields from workspace data into a clean object
 * @param workspaceData Raw workspace data from LoadWorkspaceTool or similar
 * @param options Formatting options
 * @returns Formatted workspace data object
 */
export function extractWorkspaceData(
  workspaceData: any,
  options: FormatOptions = {}
): FormattedWorkspaceData {
  if (!workspaceData) return {};

  const { maxStates, maxSessions } = options;
  const formatted: FormattedWorkspaceData = {};

  // Core context (memory, goal, constraints, etc.)
  if (workspaceData.context) {
    formatted.context = workspaceData.context;
  }

  // Workflows
  if (workspaceData.workflows?.length) {
    formatted.workflows = workspaceData.workflows;
  }

  // Workspace structure (folder/file tree)
  if (workspaceData.workspaceStructure?.length) {
    formatted.workspaceStructure = workspaceData.workspaceStructure;
  }

  // Recent files
  if (workspaceData.recentFiles?.length) {
    formatted.recentFiles = workspaceData.recentFiles;
  }

  // Key files
  if (workspaceData.keyFiles && Object.keys(workspaceData.keyFiles).length) {
    formatted.keyFiles = workspaceData.keyFiles;
  }

  // Preferences
  if (workspaceData.preferences) {
    formatted.preferences = workspaceData.preferences;
  }

  // Sessions (with optional limit)
  if (workspaceData.sessions?.length) {
    formatted.sessions = maxSessions
      ? workspaceData.sessions.slice(0, maxSessions)
      : workspaceData.sessions;
  }

  // States (with optional limit for subagents that don't need full history)
  if (workspaceData.states?.length) {
    formatted.states = maxStates
      ? workspaceData.states.slice(0, maxStates)
      : workspaceData.states;
  }

  return formatted;
}

/**
 * Format workspace data as JSON string for inclusion in prompts
 * @param workspaceData Raw workspace data
 * @param options Formatting options
 * @returns JSON string or empty string if no data
 */
export function formatWorkspaceDataForPrompt(
  workspaceData: any,
  options: FormatOptions = {}
): string {
  const formatted = extractWorkspaceData(workspaceData, options);

  if (Object.keys(formatted).length === 0) {
    return '';
  }

  const { prettyPrint = true } = options;
  return prettyPrint
    ? JSON.stringify(formatted, null, 2)
    : JSON.stringify(formatted);
}

/**
 * Check if workspace data has any meaningful content
 * @param workspaceData Raw workspace data
 * @returns true if there's content worth including in a prompt
 */
export function hasWorkspaceContent(workspaceData: any): boolean {
  if (!workspaceData) return false;

  return !!(
    workspaceData.context ||
    workspaceData.workflows?.length ||
    workspaceData.workspaceStructure?.length ||
    workspaceData.recentFiles?.length ||
    (workspaceData.keyFiles && Object.keys(workspaceData.keyFiles).length) ||
    workspaceData.preferences ||
    workspaceData.sessions?.length ||
    workspaceData.states?.length
  );
}
