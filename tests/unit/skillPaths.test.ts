/**
 * skillPaths Unit Tests
 *
 * The traversal/containment boundary for the Skills app. Verifies that:
 *  - resolveVaultPath folds away `.`/`..`/empty segments (Obsidian's
 *    normalizePath does NOT), so containment checks can't be fooled.
 *  - assertInside accepts paths inside the root and throws SkillPathError for
 *    any path that resolves outside it (the core defense behind the audit's
 *    BLOCKING traversal findings).
 *  - isSafePathSegment rejects traversal-bearing single segments.
 */

import {
  resolveVaultPath,
  assertInside,
  isSafePathSegment,
  SkillPathError,
} from '@/agents/apps/skills/services/skillPaths';

describe('skillPaths', () => {
  describe('resolveVaultPath', () => {
    it('folds away "." and empty segments', () => {
      expect(resolveVaultPath('Nexus/./skills//claude')).toBe('Nexus/skills/claude');
    });

    it('resolves ".." by popping the prior segment', () => {
      expect(resolveVaultPath('Nexus/skills/claude/../codex')).toBe('Nexus/skills/codex');
    });

    it('collapses a traversal that climbs above the start (never begins with "..")', () => {
      // Nexus/skills/../../../etc → etc (the leading climbs pop nothing).
      expect(resolveVaultPath('Nexus/skills/../../../etc')).toBe('etc');
      expect(resolveVaultPath('../../etc/passwd')).toBe('etc/passwd');
    });
  });

  describe('assertInside', () => {
    const ROOT = 'Nexus/skills';

    it('returns the resolved path for a child of the root', () => {
      expect(assertInside(ROOT, 'Nexus/skills/claude/essay-editor')).toBe(
        'Nexus/skills/claude/essay-editor'
      );
    });

    it('accepts the root itself', () => {
      expect(assertInside(ROOT, 'Nexus/skills')).toBe('Nexus/skills');
    });

    it('resolves "." / ".." inside the root and still accepts', () => {
      expect(assertInside(ROOT, 'Nexus/skills/claude/../codex/x')).toBe('Nexus/skills/codex/x');
    });

    it('throws when the candidate escapes the root via ".."', () => {
      expect(() => assertInside(ROOT, 'Nexus/skills/../../../.obsidian')).toThrow(SkillPathError);
    });

    it('throws for a sibling that merely shares a name prefix', () => {
      // "Nexus/skills-evil" must NOT count as inside "Nexus/skills".
      expect(() => assertInside(ROOT, 'Nexus/skills-evil/x')).toThrow(SkillPathError);
    });

    it('throws for an empty containment root', () => {
      expect(() => assertInside('', 'anything')).toThrow(SkillPathError);
    });
  });

  describe('isSafePathSegment', () => {
    it.each(['claude', 'codex', 'essay-editor', '.claude', 'My_Skill', 'a1-b2'])(
      'accepts safe segment "%s"',
      (seg) => {
        expect(isSafePathSegment(seg)).toBe(true);
      }
    );

    it.each(['', '.', '..', 'a/b', 'a\\b'])('rejects unsafe segment "%s"', (seg) => {
      expect(isSafePathSegment(seg)).toBe(false);
    });
  });
});
