import type { InstructionReference } from './types';

/** Structured keys distinguish types and qualified names without delimiter collisions. */
export function encodeInstructionReference(reference: InstructionReference): string {
  return JSON.stringify(reference.type === 'prompt'
    ? ['prompt', reference.id]
    : ['skill', reference.provider, reference.name]);
}

export function decodeInstructionReference(key: string): InstructionReference | undefined {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value)) return undefined;
    const parts: readonly unknown[] = value;
    if (!parts.every(item => typeof item === 'string' && item.trim().length > 0)) return undefined;
    const [type, first, second] = parts;
    if (parts.length === 2 && type === 'prompt' && typeof first === 'string') return { type: 'prompt', id: first };
    if (parts.length === 3 && type === 'skill' && typeof first === 'string' && typeof second === 'string') return { type: 'skill', provider: first, name: second };
    return undefined;
  } catch { return undefined; }
}

export function normalizeInstructionCategories(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(Boolean))];
}
