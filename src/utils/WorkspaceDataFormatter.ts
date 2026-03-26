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

type WorkspaceDataInput = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getWorkspaceDataInput(workspaceData: unknown): WorkspaceDataInput | null {
  return isRecord(workspaceData) ? workspaceData : null;
}

function getArrayField(
  workspaceData: WorkspaceDataInput,
  key: 'workflows' | 'workspaceStructure' | 'recentFiles' | 'sessions' | 'states'
): unknown[] | undefined {
  const value = workspaceData[key];
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function getSlicedArrayField(
  workspaceData: WorkspaceDataInput,
  key: 'sessions' | 'states',
  maxItems?: number
): unknown[] | undefined {
  const value = getArrayField(workspaceData, key);

  if (!value) {
    return undefined;
  }

  return maxItems ? value.slice(0, maxItems) : value;
}

function getKeyFilesField(
  workspaceData: WorkspaceDataInput
): Record<string, unknown> | undefined {
  const value = workspaceData.keyFiles;
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}

function getPreferencesField(workspaceData: WorkspaceDataInput): string | undefined {
  const value = workspaceData.preferences;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Extract relevant fields from workspace data into a clean object
 * @param workspaceData Raw workspace data from LoadWorkspaceTool or similar
 * @param options Formatting options
 * @returns Formatted workspace data object
 */
export function extractWorkspaceData(
  workspaceData: unknown,
  options: FormatOptions = {}
): FormattedWorkspaceData {
  const input = getWorkspaceDataInput(workspaceData);

  if (!input) return {};

  const { maxStates, maxSessions } = options;
  const formatted: FormattedWorkspaceData = {};
  const workflows = getArrayField(input, 'workflows');
  const workspaceStructure = getArrayField(input, 'workspaceStructure');
  const recentFiles = getArrayField(input, 'recentFiles');
  const keyFiles = getKeyFilesField(input);
  const preferences = getPreferencesField(input);
  const sessions = getSlicedArrayField(input, 'sessions', maxSessions);
  const states = getSlicedArrayField(input, 'states', maxStates);

  // Core context (memory, goal, constraints, etc.)
  if (input.context) {
    formatted.context = input.context;
  }

  // Workflows
  if (workflows) {
    formatted.workflows = workflows;
  }

  // Workspace structure (folder/file tree)
  if (workspaceStructure) {
    formatted.workspaceStructure = workspaceStructure;
  }

  // Recent files
  if (recentFiles) {
    formatted.recentFiles = recentFiles;
  }

  // Key files
  if (keyFiles) {
    formatted.keyFiles = keyFiles;
  }

  // Preferences
  if (preferences) {
    formatted.preferences = preferences;
  }

  // Sessions (with optional limit)
  if (sessions) {
    formatted.sessions = sessions;
  }

  // States (with optional limit for subagents that don't need full history)
  if (states) {
    formatted.states = states;
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
  workspaceData: unknown,
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
export function hasWorkspaceContent(workspaceData: unknown): boolean {
  const input = getWorkspaceDataInput(workspaceData);

  if (!input) return false;

  return !!(
    input.context ||
    getArrayField(input, 'workflows') ||
    getArrayField(input, 'workspaceStructure') ||
    getArrayField(input, 'recentFiles') ||
    getKeyFilesField(input) ||
    getPreferencesField(input) ||
    getArrayField(input, 'sessions') ||
    getArrayField(input, 'states')
  );
}
