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

/**
 * Hash SKILL.md *content* for change-detection / skip-identical-writes (§3).
 *
 * Normalizes line endings (CRLF/CR → LF) before hashing so a file that only
 * differs by line-ending style (e.g. a provider dotfolder written by a Windows
 * tool vs. our always-LF `composeSkillMd` output) is NOT seen as changed.
 * Without this, every import/sync-back would perpetually re-write and re-archive
 * identical content. Use this — NOT raw {@link fnv1aHex} — for any SKILL.md
 * body comparison.
 */
export function hashSkillContent(content: string): string {
  return fnv1aHex(content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}
