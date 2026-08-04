import {
  isMetadataUpdateTriviallyEmpty,
  resolveMetadataUpdate
} from '../../src/database/repositories/metadataUpdate';

describe('metadata updates', () => {
  it('shallow-merges by default and preserves unrelated keys', () => {
    expect(resolveMetadataUpdate({
      current: { keep: true, nested: { a: 1, b: 2 } },
      metadata: { nested: { b: 3 }, added: 1 }
    })).toEqual({ keep: true, nested: { b: 3 }, added: 1 });
  });

  it('preserves falsy and null patch values', () => {
    expect(resolveMetadataUpdate({
      current: { flag: true, count: 1, label: 'x', value: 'x' },
      metadata: { flag: false, count: 0, label: '', value: null }
    })).toEqual({ flag: false, count: 0, label: '', value: null });
  });

  it('ignores undefined patch values', () => {
    expect(resolveMetadataUpdate({
      current: { keep: true },
      metadata: { keep: undefined, added: 1 }
    })).toEqual({ keep: true, added: 1 });
  });

  it('replaces the complete object in replace mode', () => {
    expect(resolveMetadataUpdate({
      current: { old: true },
      metadata: { replacement: true },
      metadataMode: 'replace'
    })).toEqual({ replacement: true });
  });

  it('clears metadata with replace and an empty object', () => {
    expect(resolveMetadataUpdate({
      current: { old: true },
      metadata: {},
      metadataMode: 'replace'
    })).toEqual({});
  });

  it('applies removals after the merge patch', () => {
    expect(resolveMetadataUpdate({
      current: { keep: true, stale: 1 },
      metadata: { added: 2 },
      removeMetadataKeys: ['stale']
    })).toEqual({ keep: true, added: 2 });
  });

  it('returns undefined for empty or ineffective merge operations', () => {
    expect(resolveMetadataUpdate({ current: { keep: true }, metadata: {} })).toBeUndefined();
    expect(resolveMetadataUpdate({ current: { keep: true }, removeMetadataKeys: ['missing'] })).toBeUndefined();
  });

  it('rejects replace without metadata', () => {
    expect(() => resolveMetadataUpdate({ metadataMode: 'replace' })).toThrow(/requires.*metadata/);
  });

  it('rejects replace combined with removals', () => {
    expect(() => resolveMetadataUpdate({
      metadataMode: 'replace',
      metadata: {},
      removeMetadataKeys: ['old']
    })).toThrow(/removeMetadataKeys/);
  });

  it('rejects invalid runtime metadata shapes', () => {
    expect(() => isMetadataUpdateTriviallyEmpty({
      metadata: [] as unknown as Record<string, unknown>
    })).toThrow(/metadata must be an object/);
    expect(() => isMetadataUpdateTriviallyEmpty({
      metadata: null as unknown as Record<string, unknown>
    })).toThrow(/metadata must be an object/);
  });

  it('rejects invalid modes before no-op detection', () => {
    expect(() => isMetadataUpdateTriviallyEmpty({
      metadataMode: 'invalid' as 'merge'
    })).toThrow(/metadataMode/);
  });

  it('rejects invalid removal lists before no-op detection', () => {
    expect(() => isMetadataUpdateTriviallyEmpty({
      removeMetadataKeys: 'key' as unknown as string[]
    })).toThrow(/removeMetadataKeys/);
    expect(() => isMetadataUpdateTriviallyEmpty({
      removeMetadataKeys: [' ']
    })).toThrow(/removeMetadataKeys/);
  });

  it('recognizes only validated, current-independent no-ops', () => {
    expect(isMetadataUpdateTriviallyEmpty({ metadata: {} })).toBe(true);
    expect(isMetadataUpdateTriviallyEmpty({ metadataMode: 'merge', removeMetadataKeys: [] })).toBe(true);
    expect(isMetadataUpdateTriviallyEmpty({ removeMetadataKeys: ['possibly-present'] })).toBe(false);
    expect(isMetadataUpdateTriviallyEmpty({ metadataMode: 'replace', metadata: {} })).toBe(false);
  });
});
