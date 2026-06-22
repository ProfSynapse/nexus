/**
 * notesIndexMapping unit tests — the typed frontmatter→property-row coercion and
 * the change-detection hash. Pure, no Obsidian/SQLite. This is the main
 * correctness surface of the notes index (no query-time evaluator).
 */

import {
  coerceFrontmatterValue,
  computeContentHash,
  type NotePropertyRow,
} from '../../src/database/services/notesIndex/notesIndexMapping';

function one(key: string, value: unknown): NotePropertyRow {
  const rows = coerceFrontmatterValue(key, value);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('coerceFrontmatterValue', () => {
  it('lowercases the match key but preserves the raw key', () => {
    const r = one('Status', 'active');
    expect(r.key).toBe('status');
    expect(r.keyRaw).toBe('Status');
  });

  it('coerces strings', () => {
    const r = one('status', 'active');
    expect(r).toMatchObject({ valueText: 'active', valueNum: null, valueType: 'string', position: null });
  });

  it('coerces numbers into both text and num', () => {
    const r = one('priority', 3);
    expect(r).toMatchObject({ valueText: '3', valueNum: 3, valueType: 'number' });
  });

  it('coerces booleans into 1/0', () => {
    expect(one('done', true)).toMatchObject({ valueText: 'true', valueNum: 1, valueType: 'boolean' });
    expect(one('done', false)).toMatchObject({ valueText: 'false', valueNum: 0, valueType: 'boolean' });
  });

  it('coerces ISO date strings to epoch ms in value_num', () => {
    const r = one('due', '2026-06-21');
    expect(r.valueType).toBe('date');
    expect(r.valueText).toBe('2026-06-21');
    expect(r.valueNum).toBe(Date.parse('2026-06-21'));
  });

  it('coerces Date objects to epoch ms', () => {
    const d = new Date('2026-01-02T03:04:05Z');
    const r = one('due', d);
    expect(r.valueType).toBe('date');
    expect(r.valueNum).toBe(d.getTime());
  });

  it('does not treat a non-date string as a date', () => {
    const r = one('title', '2026 roadmap');
    expect(r.valueType).toBe('string');
    expect(r.valueNum).toBeNull();
  });

  it('coerces null/undefined to a null-typed row', () => {
    expect(one('x', null)).toMatchObject({ valueType: 'null', valueText: null, valueNum: null });
    expect(one('x', undefined)).toMatchObject({ valueType: 'null' });
  });

  it('expands arrays to one positioned row per element', () => {
    const rows = coerceFrontmatterValue('tags', ['a', 'b', 'c']);
    expect(rows.map((r) => [r.valueText, r.position])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(rows.every((r) => r.key === 'tags')).toBe(true);
  });

  it('emits a single list marker row for an empty array', () => {
    const rows = coerceFrontmatterValue('tags', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ valueType: 'list', valueText: null, position: null });
  });

  it('stores nested objects as JSON in value_text', () => {
    const r = one('meta', { a: 1, b: 2 });
    expect(r.valueType).toBe('object');
    expect(JSON.parse(r.valueText as string)).toEqual({ a: 1, b: 2 });
  });
});

describe('computeContentHash', () => {
  it('is stable across key ordering', () => {
    const a = computeContentHash({ status: 'active', priority: 2 }, 100, 10);
    const b = computeContentHash({ priority: 2, status: 'active' }, 100, 10);
    expect(a).toBe(b);
  });

  it('changes when frontmatter, mtime, or size change', () => {
    const base = computeContentHash({ status: 'active' }, 100, 10);
    expect(computeContentHash({ status: 'done' }, 100, 10)).not.toBe(base);
    expect(computeContentHash({ status: 'active' }, 101, 10)).not.toBe(base);
    expect(computeContentHash({ status: 'active' }, 100, 11)).not.toBe(base);
  });
});
