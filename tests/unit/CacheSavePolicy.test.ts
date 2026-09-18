/**
 * The save cadence policy, Phase 2 / Option B item 1 of
 * docs/plans/sqlite-cache-persistence-plan.md.
 *
 * There is no mock in this file. The policy is arithmetic over a byte count
 * and a clock, both supplied by the test, so nothing here can pass because a
 * stand-in agreed with itself. What it cannot see is whether the cost model is
 * right; that came from the Phase 3 spike's measurements against a real
 * Obsidian renderer (spike findings, sections 5c and 5d) and is pinned here
 * only so a later edit to the constants has to be deliberate.
 */

import {
  SaveCadence,
  computeSaveCadence,
  describeCacheSaveFailure,
  estimateSaveCostMs,
  readCacheSizeBytes
} from '../../src/services/embeddings/CacheSavePolicy';

const MB = 1024 * 1024;

describe('estimateSaveCostMs', () => {
  // The spike timed the real desktop save path at 378 ms for a 152.4 MB
  // database and 161 ms for a 56.1 MB one. The model is allowed to be
  // approximate; it is not allowed to be off by a factor.
  it('lands near the measured cost of a real save', () => {
    expect(estimateSaveCostMs(152 * MB)).toBeGreaterThan(300);
    expect(estimateSaveCostMs(152 * MB)).toBeLessThan(450);
    expect(estimateSaveCostMs(56 * MB)).toBeGreaterThan(110);
    expect(estimateSaveCostMs(56 * MB)).toBeLessThan(200);
  });

  it('costs nothing when nothing is known about the size', () => {
    expect(estimateSaveCostMs(null)).toBe(0);
    expect(estimateSaveCostMs(0)).toBe(0);
    expect(estimateSaveCostMs(Number.NaN)).toBe(0);
  });
});

describe('computeSaveCadence', () => {
  // The behaviour that was there before this policy existed, preserved for the
  // case that matters most: a fresh install, where a save is cheap and losing
  // ten notes of work is not worth avoiding it.
  it('is the flat floor and no waiting when the size is unknown', () => {
    expect(computeSaveCadence(null, 10)).toEqual({
      items: 10,
      intervalMs: 0,
      estimatedSaveCostMs: 0
    });
  });

  it('widens both floors as the database grows, and never narrows them', () => {
    const sizes = [0, 4 * MB, 16 * MB, 56 * MB, 152 * MB, 400 * MB, 2048 * MB];
    const cadences = sizes.map(size => computeSaveCadence(size, 10));

    for (let i = 1; i < cadences.length; i++) {
      expect(cadences[i].items).toBeGreaterThanOrEqual(cadences[i - 1].items);
      expect(cadences[i].intervalMs).toBeGreaterThanOrEqual(cadences[i - 1].intervalMs);
    }
    // And it does actually move, or the assertion above is vacuous.
    expect(cadences[cadences.length - 1].items).toBeGreaterThan(cadences[0].items);
    expect(cadences[cadences.length - 1].intervalMs).toBeGreaterThan(cadences[0].intervalMs);
  });

  // The number the plan is trying to reach: roughly 1800 exports per full
  // index of an 18k-note vault becoming low hundreds.
  it('asks for far fewer snapshots per full index at the size that motivated the plan', () => {
    const { items } = computeSaveCadence(152 * MB, 10);
    const snapshotsPerFullIndex = Math.ceil(18000 / items);

    expect(items).toBeGreaterThan(50);
    expect(snapshotsPerFullIndex).toBeLessThan(400);
  });

  it('caps both floors so an enormous cache cannot stop saving altogether', () => {
    const huge = computeSaveCadence(100 * 1024 * MB, 10);
    expect(huge.items).toBeLessThanOrEqual(250);
    expect(huge.intervalMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('never saves more often than the floor the caller asked for, however small the cache', () => {
    expect(computeSaveCadence(1, 25).items).toBe(25);
  });
});

describe('SaveCadence', () => {
  function createCadence(sizeBytes: number | null, minItems = 10) {
    let now = 1_000_000;
    const cadence = new SaveCadence({
      minItems,
      db: { getLastSavedBytes: () => sizeBytes },
      now: () => now
    });
    return {
      cadence,
      advance: (ms: number) => { now += ms; },
      items: (count: number) => {
        for (let i = 0; i < count; i++) cadence.recordItem();
      }
    };
  }

  // "Whichever is later" in the plan means both floors, not either.
  it('waits for the item floor even once the time floor has passed', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    advance(10 * 60 * 1000);
    items(5);
    expect(cadence.shouldSave()).toBe(false);
  });

  it('waits for the time floor even once the item floor has passed', () => {
    const { cadence, items } = createCadence(152 * MB);
    items(500);
    expect(cadence.shouldSave()).toBe(false);
  });

  it('saves once both floors are met', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    items(500);
    advance(10 * 60 * 1000);
    expect(cadence.shouldSave()).toBe(true);
  });

  it('starts counting again from a save attempt', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    items(500);
    advance(10 * 60 * 1000);
    expect(cadence.shouldSave()).toBe(true);

    cadence.markSaveAttempt();
    expect(cadence.shouldSave()).toBe(false);
  });

  // A save that fails costs the same hundreds of milliseconds as one that
  // succeeds, so asking again on the very next item spends that cost to be
  // refused again. The unsaved data is not forgotten: the dirty flag in
  // SQLiteCacheManager is what remembers it, not this counter.
  it('backs off after a failed attempt exactly as after a successful one', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    items(500);
    advance(10 * 60 * 1000);
    cadence.markSaveAttempt();

    items(500);
    expect(cadence.shouldSave()).toBe(false);
    advance(10 * 60 * 1000);
    expect(cadence.shouldSave()).toBe(true);
  });

  it('falls back to the flat floor when the cache cannot say how big it is', () => {
    const { cadence, items } = createCadence(null);
    items(9);
    expect(cadence.shouldSave()).toBe(false);
    items(1);
    expect(cadence.shouldSave()).toBe(true);
  });
});

describe('readCacheSizeBytes', () => {
  // A save path may not throw because a diagnostic accessor was missing.
  it('answers null rather than throwing for a source that cannot say', () => {
    expect(readCacheSizeBytes({})).toBeNull();
    expect(readCacheSizeBytes({
      getLastSavedBytes: () => { throw new Error('database not initialized'); }
    })).toBeNull();
  });
});

describe('describeCacheSaveFailure', () => {
  // The whole point of Phase 2's second item: the line a user sees has to be
  // about persistence, and has to carry the number that explains it.
  it('names the source, the stage and the byte count, and blames no note', () => {
    const message = describeCacheSaveFailure('IndexingQueue', 'periodic', 152 * MB);

    expect(message).toContain('[IndexingQueue]');
    expect(message).toContain('Failed to save the cache');
    expect(message).toContain('periodic save');
    expect(message).toContain(String(152 * MB));
    expect(message).not.toContain('Failed to embed');
  });

  it('says the size is unknown rather than inventing a zero', () => {
    expect(describeCacheSaveFailure('TraceIndexer', 'final', null)).toContain('size unknown');
    expect(describeCacheSaveFailure('TraceIndexer', 'final', 0)).toContain('size unknown');
  });
});
