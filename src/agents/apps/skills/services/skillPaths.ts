/**
 * skillPaths — path-safety helpers for the Skills app.
 *
 * Located at: src/agents/apps/skills/services/skillPaths.ts
 *
 * The Skills app builds vault-relative paths from BOTH model-supplied fields
 * (createSkill/updateSkill `source`/`name`) AND disk-scanned folder names
 * (provider dotfolders, mirror folders). Obsidian's `normalizePath` collapses
 * slashes but does NOT resolve or strip `..` segments — so a `..`-bearing
 * segment flows straight through to `adapter.write/read/mkdir/remove/rmdir` and,
 * on desktop, escapes the vault. This module is the single containment boundary:
 *
 *   - {@link resolveVaultPath} resolves `.`/`..`/empty segments so a containment
 *     check cannot be fooled.
 *   - {@link assertInside} throws unless a candidate path stays inside a root.
 *   - {@link isSafePathSegment} rejects traversal-bearing path segments (used on
 *     DISK-derived names, where we only block traversal, not naming convention).
 *
 * Naming-convention validation (lowercase-hyphenated) for AUTHORED skills lives
 * in SkillValidator (a pure, Obsidian-free module); this module is the
 * traversal/containment layer and intentionally depends on `normalizePath`.
 * See docs/plans/skills-protocol-integration-plan.md §3 / §7.
 */

import { normalizePath } from 'obsidian';

/** Thrown when a built path would escape its intended containment root. */
export class SkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPathError';
  }
}

/**
 * Resolve `.`/`..`/empty segments in a vault-relative path so containment
 * checks are robust. `normalizePath` only collapses separators; this also folds
 * away `..` (popping the prior segment) and `.`/empty segments. A leading `..`
 * that would climb above the root simply pops nothing — the result can never
 * begin with `..`, so {@link assertInside}'s prefix check stays sound.
 */
export function resolveVaultPath(path: string): string {
  const out: string[] = [];
  for (const segment of normalizePath(path).split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Assert that `candidate` resolves to a path inside (or exactly equal to)
 * `root`. Returns the resolved candidate path on success; throws
 * {@link SkillPathError} otherwise. Both inputs are `..`-resolved before the
 * prefix comparison so neither a `..` in the candidate nor in the root can fool
 * the check.
 */
export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolveVaultPath(root);
  const resolved = resolveVaultPath(candidate);
  if (resolvedRoot.length === 0) {
    throw new SkillPathError('Refusing to operate against an empty containment root');
  }
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}/`)) {
    throw new SkillPathError(`Path "${candidate}" escapes "${root}"`);
  }
  return resolved;
}

/**
 * True when a SINGLE path segment is safe to interpolate into a vault path —
 * i.e. it is non-empty and cannot cause directory traversal. This is the
 * lenient guard applied to DISK-derived provider/skill folder names (which may
 * legitimately not follow the lowercase-hyphenated authoring convention); the
 * companion {@link assertInside} re-checks the assembled path as belt-and-braces.
 */
export function isSafePathSegment(segment: string): boolean {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
}
