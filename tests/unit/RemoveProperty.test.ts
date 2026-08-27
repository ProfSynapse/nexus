/**
 * tests/unit/RemoveProperty.test.ts — unit coverage for the pure removal
 * decision used by `RemovePropertyTool.execute`.
 *
 * The tool runs the decision inside `fileManager.processFrontMatter`, but
 * `computeRemoveResult` is a pure function of (frontmatter, property, value),
 * so every branch can be asserted directly without an Obsidian App mock —
 * the same split `setProperty.ts` uses for `computeMergeResult`.
 */
import { computeRemoveResult } from '../../src/agents/contentManager/tools/removeProperty';

describe('computeRemoveResult — removal decision (RemovePropertyTool)', () => {
  describe('property absent', () => {
    it('errors rather than reporting a silent no-op, and names the keys present', () => {
      const outcome = computeRemoveResult({ tags: ['a'], status: 'draft' }, 'tag');
      expect(outcome.kind).toBe('error');
      // A typo'd property name is the failure this guards: without the error a
      // caller removing "tag" instead of "tags" would be told it worked.
      expect(outcome).toMatchObject({
        message: expect.stringContaining('Properties present: tags, status'),
      });
    });

    it('says so plainly when the note has no frontmatter at all', () => {
      expect(computeRemoveResult({}, 'tags')).toEqual({
        kind: 'error',
        message: 'Property "tags" is not set on this note. The note has no frontmatter properties.',
      });
    });

    it('treats an explicitly-undefined key as absent', () => {
      expect(computeRemoveResult({ tags: undefined }, 'tags').kind).toBe('error');
    });

    it('does not treat a null value as absent — null is a set value, so it is removable', () => {
      expect(computeRemoveResult({ status: null }, 'status')).toEqual({ kind: 'delete' });
    });
  });

  describe('no value — whole-property removal', () => {
    it('deletes a scalar property', () => {
      expect(computeRemoveResult({ status: 'draft' }, 'status')).toEqual({ kind: 'delete' });
    });

    it('deletes a list property outright', () => {
      expect(computeRemoveResult({ tags: ['a', 'b'] }, 'tags')).toEqual({ kind: 'delete' });
    });

    it('deletes a property holding falsy values (empty string, false, 0)', () => {
      expect(computeRemoveResult({ a: '' }, 'a')).toEqual({ kind: 'delete' });
      expect(computeRemoveResult({ a: false }, 'a')).toEqual({ kind: 'delete' });
      expect(computeRemoveResult({ a: 0 }, 'a')).toEqual({ kind: 'delete' });
    });
  });

  describe('value + list property — item removal (inverse of set-property --mode merge)', () => {
    it('drops one item and keeps the rest in order', () => {
      expect(computeRemoveResult({ tags: ['a', 'b', 'c'] }, 'tags', 'b')).toEqual({
        kind: 'replace',
        value: ['a', 'c'],
      });
    });

    it('drops several items in one call', () => {
      expect(computeRemoveResult({ tags: ['a', 'b', 'c'] }, 'tags', ['a', 'c'])).toEqual({
        kind: 'replace',
        value: ['b'],
      });
    });

    it('drops every occurrence of a duplicated item', () => {
      expect(computeRemoveResult({ tags: ['a', 'b', 'a'] }, 'tags', 'a')).toEqual({
        kind: 'replace',
        value: ['b'],
      });
    });

    it('removes the property itself once the last item is gone', () => {
      // Rather than leaving `tags: []` behind in the frontmatter.
      expect(computeRemoveResult({ tags: ['a'] }, 'tags', 'a')).toEqual({ kind: 'delete' });
    });

    it('handles wikilink values verbatim — no bracket unwrapping', () => {
      expect(computeRemoveResult({ related: ['[[A]]', '[[B]]'] }, 'related', '[[A]]')).toEqual({
        kind: 'replace',
        value: ['[[B]]'],
      });
    });

    it('errors when the value is not in the list, naming what is', () => {
      const outcome = computeRemoveResult({ tags: ['a', 'b'] }, 'tags', 'z');
      expect(outcome.kind).toBe('error');
      expect(outcome).toMatchObject({ message: expect.stringContaining('Current value: ["a", "b"]') });
    });

    it('errors on a partially-matching batch without removing the matching half', () => {
      // All-or-nothing: a caller that passed one bad item gets told, rather
      // than half a removal reported as success.
      expect(computeRemoveResult({ tags: ['a', 'b'] }, 'tags', ['a', 'z']).kind).toBe('error');
    });

    it('matches a CLI-string value against a numeric list entry', () => {
      // Every CLI argument arrives as a string; `years: [2023, 2024]` would
      // never match `--value "2024"` under strict equality.
      expect(computeRemoveResult({ years: [2023, 2024] }, 'years', '2024')).toEqual({
        kind: 'replace',
        value: [2023],
      });
    });
  });

  describe('value + scalar property', () => {
    it('deletes the property when the value matches', () => {
      expect(computeRemoveResult({ status: 'draft' }, 'status', 'draft')).toEqual({ kind: 'delete' });
    });

    it('matches a CLI-string value against a numeric scalar', () => {
      expect(computeRemoveResult({ year: 2024 }, 'year', '2024')).toEqual({ kind: 'delete' });
    });

    it('matches a CLI-string value against a boolean scalar', () => {
      expect(computeRemoveResult({ pinned: true }, 'pinned', 'true')).toEqual({ kind: 'delete' });
    });

    it('errors when the value does not match, naming the actual value', () => {
      const outcome = computeRemoveResult({ status: 'draft' }, 'status', 'done');
      expect(outcome.kind).toBe('error');
      expect(outcome).toMatchObject({ message: expect.stringContaining('its value is "draft"') });
    });

    it('errors when several values are offered for a single-valued property', () => {
      const outcome = computeRemoveResult({ status: 'draft' }, 'status', ['draft', 'done']);
      expect(outcome.kind).toBe('error');
      expect(outcome).toMatchObject({ message: expect.stringContaining('not a list') });
    });

    it('does not string-compare objects into a false match', () => {
      // Both sides stringify to "[object Object]"; a loose compare would
      // delete an unrelated map.
      expect(computeRemoveResult({ meta: { a: 1 } }, 'meta', { b: 2 } as unknown as string).kind).toBe('error');
    });
  });
});
