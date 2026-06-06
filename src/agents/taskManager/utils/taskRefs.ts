const TASK_REF_PREFIX = 'T-';
const TASK_REF_LENGTH = 8;

function compactTaskId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Human-facing short reference for task IDs. UUIDs remain the storage key; refs
 * are a compact alias for tool calls and status labels.
 */
export function formatTaskRef(taskId: string): string {
  const compact = compactTaskId(taskId);
  const suffix = compact.length > 0 ? compact.slice(0, TASK_REF_LENGTH) : taskId.trim().slice(0, TASK_REF_LENGTH);
  return `${TASK_REF_PREFIX}${suffix}`;
}

/**
 * Extract the normalized ID prefix represented by a task ref. Accepts the
 * canonical `T-1a2b3c4d` shape and a bare compact prefix for convenience.
 */
export function taskRefToIdPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^t(?:ask)?[-_: ]?([a-z0-9][a-z0-9-_: ]{3,})$/i);
  if (prefixed) {
    return compactTaskId(prefixed[1]);
  }

  const compact = compactTaskId(trimmed);
  if (/^[a-f0-9]{6,32}$/i.test(compact)) {
    return compact;
  }

  return null;
}

export function formatTaskRefForLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'task';
  if (/^t(?:ask)?[-_: ]/i.test(trimmed)) return trimmed;
  if (trimmed.length > 12) return formatTaskRef(trimmed);
  return trimmed;
}
