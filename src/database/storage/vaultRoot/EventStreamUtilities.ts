import { normalizePath } from 'obsidian';

export type EventStreamCategory = 'conversations' | 'workspaces' | 'tasks';

export const EVENT_STREAM_CATEGORIES: EventStreamCategory[] = [
  'conversations',
  'workspaces',
  'tasks'
];

export interface EventStreamPathParseResult {
  category: EventStreamCategory;
  logicalId: string;
  fileStem: string;
  fileName: string;
}

function normalizeLogicalIdSegments(logicalId: string): string {
  const normalizedId = normalizePath(logicalId).replace(/^\/+|\/+$/g, '');
  if (!normalizedId) {
    throw new Error('Event stream ID cannot be empty.');
  }

  return normalizedId;
}

export function normalizeConversationEventStreamId(logicalId: string): string {
  let normalized = normalizeLogicalIdSegments(logicalId);

  while (normalized.startsWith('conv_conv_')) {
    normalized = normalized.slice('conv_'.length);
  }

  return normalized;
}

export function normalizeEventStreamId(
  category: EventStreamCategory,
  logicalId: string
): string {
  if (category === 'conversations') {
    return normalizeConversationEventStreamId(logicalId);
  }

  return normalizeLogicalIdSegments(logicalId);
}

export function buildEventStreamPath(
  category: EventStreamCategory,
  fileStem: string
): string {
  return `${category}/${normalizeEventStreamId(category, fileStem)}.jsonl`;
}

export function parseEventStreamPath(
  relativePath: string
): EventStreamPathParseResult | null {
  const normalizedPath = normalizePath(relativePath).replace(/^\/+|\/+$/g, '');
  const match = normalizedPath.match(/^(conversations|workspaces|tasks)\/(.+)\.jsonl$/);
  if (!match) {
    return null;
  }

  const category = match[1] as EventStreamCategory;
  const fileStem = match[2];
  return {
    category,
    logicalId: normalizeEventStreamId(category, fileStem),
    fileStem,
    fileName: `${fileStem}.jsonl`
  };
}

export function stableEventSignature(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableEventSignature(item)).join(',')}]`;
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return JSON.stringify(value);
  }

  if (valueType === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableEventSignature(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
