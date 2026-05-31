/**
 * skillHash — shared content hashing for the Skills app.
 *
 * Located at: src/agents/apps/skills/services/skillHash.ts
 * Extracted so the scanner (change detection) and the write service (skip
 * identical writes, §3) share ONE implementation. Deliberately avoids Node
 * `crypto` (mobile-unsafe) and adds no dependency.
 */

/** FNV-1a (32-bit) hex hash. Mobile-safe (no Node crypto). */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit unsigned via Math.imul + >>> 0
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
