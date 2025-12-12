export interface ToolNameMetadata {
  displayName: string;
  technicalName?: string;
  agentName?: string;
  actionName?: string;
}

export interface ParsedAgentToolName {
  raw: string;
  agentName: string;
  suffix?: string;
}

export interface ParsedAgentModeToolName {
  raw: string;
  agentName: string;
  modeName: string;
}

/**
 * Replace underscores with dots for consistent agent.mode formatting.
 */
export function normalizeToolName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  return name.replace(/_/g, '.');
}

/**
 * Convert a technical tool identifier to a human-friendly display label.
 * Falls back to the original value when formatting fails.
 */
export function formatToolDisplayName(name?: string): string {
  if (!name || typeof name !== 'string') {
    return 'Tool';
  }

  const normalized = normalizeToolName(name) ?? name;
  const segments = normalized.split('.');
  const actionSegment = segments.length > 1 ? segments[segments.length - 1] : normalized;

  const title = toTitleCase(actionSegment);
  return title || name;
}

/**
 * Extract useful name metadata for display (agent/action/technical).
 */
export function getToolNameMetadata(name?: string): ToolNameMetadata {
  const technicalName = normalizeToolName(name);
  const segments = technicalName ? technicalName.split('.') : [];
  const agentSegment = segments.length > 1 ? segments[0] : undefined;
  const actionSegment = segments.length > 0 ? segments[segments.length - 1] : undefined;

  return {
    displayName: formatToolDisplayName(name),
    technicalName: technicalName ?? name,
    agentName: agentSegment ? toTitleCase(agentSegment) : undefined,
    actionName: actionSegment ? toTitleCase(actionSegment) : undefined
  };
}

function toTitleCase(value: string): string {
  return value
    .replace(/[_\-]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Parse a tool name that may include a suffix (e.g. vault identifier).
 *
 * Supported formats:
 * - `agentName`
 * - `agentName_<suffix...>` (suffix may contain underscores)
 */
export function parseAgentToolName(toolName: string): ParsedAgentToolName {
  const raw = toolName ?? '';
  const value = String(raw);

  const underscore = value.indexOf('_');
  if (underscore === -1) {
    return { raw: value, agentName: value };
  }

  const agentName = value.slice(0, underscore);
  const suffix = value.slice(underscore + 1);

  return {
    raw: value,
    agentName: agentName || value,
    suffix: suffix || undefined
  };
}

/**
 * Parse a tool identifier in `agentName_modeName` form.
 */
export function parseAgentModeToolName(toolName: string): ParsedAgentModeToolName | null {
  const parsed = parseAgentToolName(toolName);
  if (!parsed.suffix) {
    return null;
  }

  return {
    raw: parsed.raw,
    agentName: parsed.agentName,
    modeName: parsed.suffix
  };
}

export function formatAgentModeToolName(agentName: string, modeName: string): string {
  return `${agentName}_${modeName}`;
}

/**
 * Resolve a canonical `{ agentName, modeName }` pair from the tool name + arguments.
 *
 * - For agent-tools: toolName is `agentName` (or `agentName_<vaultSuffix>`) and mode is in arguments.
 * - For mode-tools: toolName is `agentName_modeName` and arguments may omit mode.
 */
export function resolveAgentMode(
  toolName: string,
  modeFromArguments?: unknown
): ParsedAgentModeToolName {
  const parsedAgent = parseAgentToolName(toolName);
  const modeName =
    typeof modeFromArguments === 'string' && modeFromArguments.trim().length > 0
      ? modeFromArguments.trim()
      : parsedAgent.suffix || 'unknown';

  return {
    raw: parsedAgent.raw,
    agentName: parsedAgent.agentName,
    modeName
  };
}
