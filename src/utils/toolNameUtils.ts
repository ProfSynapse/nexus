export interface ToolNameMetadata {
  displayName: string;
  technicalName?: string;
  agentName?: string;
  actionName?: string;
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
    .replace(/[_-]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
