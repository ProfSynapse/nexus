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
  MAX_ITEMS_AT_RISK,
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

  // Below the data-at-risk ceiling the time floor still paces the run. A 16 MB
  // cache asks for ten items and four seconds, so ten items on their own are
  // not enough.
  it('waits for the time floor even once the item floor has passed', () => {
    const { cadence, items } = createCadence(16 * MB);
    items(20);
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
  // refused again. What a failed save does not do is make the data safe, so
  // the back-off after one is the flat floor rather than the full cadence.
  it('backs off after a failed attempt, but only by the flat floor', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    items(500);
    advance(10 * 60 * 1000);
    cadence.markSaveAttempt();

    items(9);
    expect(cadence.shouldSave()).toBe(false);
    items(1);
    expect(cadence.shouldSave()).toBe(true);
  });

  it('backs off for the whole cadence after an attempt that landed', () => {
    const { cadence, advance, items } = createCadence(152 * MB);
    items(500);
    advance(10 * 60 * 1000);
    cadence.markSaveSuccess();
    cadence.markSaveAttempt();

    items(49);
    expect(cadence.shouldSave()).toBe(false);
    advance(10 * 60 * 1000);
    expect(cadence.shouldSave()).toBe(false);
  });

  it('falls back to the flat floor when the cache cannot say how big it is', () => {
    const { cadence, items } = createCadence(null);
    items(9);
    expect(cadence.shouldSave()).toBe(false);
    items(1);
    expect(cadence.shouldSave()).toBe(true);
  });
});

/**
 * A run driven exactly the way the three indexers drive it: record an item,
 * ask, and on a yes attempt a save, marking success only when it landed, then
 * one final save at the end whatever happened.
 *
 * The exposure it reports is computed the way the live harness computes it
 * (/tmp/nexus-verify/payload/harness.js, cadenceReport): the items before the
 * first save that landed count, the items between consecutive landed saves
 * count, and the items after the last landed save count. Those windows are
 * what a crash costs, and they are the numbers the harness put at 300 for the
 * Phase 2 cadence.
 */
function simulateRun(options: {
  sizeBytes: number | null;
  items: number;
  msPerItem: number;
  minItems?: number;
  saveFails?: (attempt: number) => boolean;
}) {
  const minItems = options.minItems ?? 10;
  let now = 1_000_000;
  const cadence = new SaveCadence({
    minItems,
    db: { getLastSavedBytes: () => options.sizeBytes },
    now: () => now
  });

  let processed = 0;
  let attempts = 0;
  const landedAt: number[] = [];

  const persist = (): void => {
    attempts++;
    const failed = options.saveFails ? options.saveFails(attempts) : false;
    if (!failed) {
      cadence.markSaveSuccess();
      landedAt.push(processed);
    }
    cadence.markSaveAttempt();
  };

  for (let i = 0; i < options.items; i++) {
    now += options.msPerItem;
    processed++;
    cadence.recordItem();
    if (cadence.shouldSave()) {
      persist();
    }
  }
  persist();

  const windows: number[] = [];
  let previous = 0;
  for (const at of landedAt) {
    windows.push(at - previous);
    previous = at;
  }
  windows.push(processed - previous);

  return {
    attempts,
    landed: landedAt.length,
    maxItemsAtRisk: Math.max(...windows)
  };
}

/**
 * The data-at-risk ceiling.
 *
 * Every number here comes from the live measurement that motivated it: a
 * headless Obsidian renderer indexed 300 synthetic notes against a 153.4 MB
 * cache in 16.4 s, so about 55 ms an item, and the Phase 2 cadence let all 300
 * of them ride on the single final save.
 */
describe('SaveCadence data-at-risk ceiling', () => {
  const LIVE_SIZE = 153 * MB;
  const LIVE_ITEMS = 300;
  const LIVE_MS_PER_ITEM = 55;

  // If the ceiling were removed, this run would take the floors, and the floors
  // cannot fire inside it at all: the time floor at this size is longer than
  // the whole run. That is the defect, stated as an assertion.
  it('fires inside a run that is shorter than the time floor', () => {
    const { intervalMs } = computeSaveCadence(LIVE_SIZE, 10);
    expect(intervalMs).toBeGreaterThan(LIVE_ITEMS * LIVE_MS_PER_ITEM);

    const run = simulateRun({
      sizeBytes: LIVE_SIZE,
      items: LIVE_ITEMS,
      msPerItem: LIVE_MS_PER_ITEM
    });

    expect(run.landed).toBeGreaterThan(1);
    expect(run.maxItemsAtRisk).toBe(MAX_ITEMS_AT_RISK);
  });

  // The cost side of the same run. Six or so saves, against 32 before the
  // size-aware cadence and 1 after it.
  it('keeps most of the reduction the size-aware cadence bought', () => {
    const run = simulateRun({
      sizeBytes: LIVE_SIZE,
      items: LIVE_ITEMS,
      msPerItem: LIVE_MS_PER_ITEM
    });

    expect(run.attempts).toBeLessThanOrEqual(8);
    expect(run.attempts).toBeLessThan(Math.ceil(LIVE_ITEMS / MAX_ITEMS_AT_RISK) + 3);
  });

  // The harness's "one transient save failure" run. A failed save clears no
  // exposure, so the next attempt comes at the flat floor rather than a whole
  // ceiling later, and the worst window is a ceiling plus a floor.
  it('does not let one transient failure double the exposure', () => {
    const run = simulateRun({
      sizeBytes: LIVE_SIZE,
      items: LIVE_ITEMS,
      msPerItem: LIVE_MS_PER_ITEM,
      saveFails: attempt => attempt === 1
    });

    expect(run.maxItemsAtRisk).toBe(MAX_ITEMS_AT_RISK + 10);
    expect(run.maxItemsAtRisk).toBeLessThan(2 * MAX_ITEMS_AT_RISK);
  });

  // The other half of that: a save that keeps failing must not be retried on
  // every item, because each refusal costs the full export.
  it('paces a save that keeps failing instead of asking on every item', () => {
    const run = simulateRun({
      sizeBytes: LIVE_SIZE,
      items: LIVE_ITEMS,
      msPerItem: LIVE_MS_PER_ITEM,
      saveFails: () => true
    });

    expect(run.landed).toBe(0);
    expect(run.attempts).toBeLessThanOrEqual(Math.ceil(LIVE_ITEMS / 10) + 2);
    expect(run.attempts).toBeLessThan(LIVE_ITEMS / 5);
  });

  // The ceiling is a ceiling, not a new floor: where a save is cheap the item
  // floor is already well below it and nothing here may change the cadence.
  // Ten items between saves, and twenty across one transient failure, are the
  // numbers the harness measured before any of this work started.
  it('is inert at a cache size where the item floor is already below it', () => {
    const small = { sizeBytes: 4 * MB, items: 300, msPerItem: 200 };
    expect(computeSaveCadence(small.sizeBytes, 10).items).toBeLessThan(MAX_ITEMS_AT_RISK);

    expect(simulateRun(small).maxItemsAtRisk).toBe(10);
    expect(simulateRun({ ...small, saveFails: attempt => attempt === 1 }).maxItemsAtRisk).toBe(20);
  });

  // Exposure is cleared by a save that landed, and by nothing else. This is the
  // distinction the whole ceiling rests on, asserted directly rather than
  // through a run.
  it('counts from the last save that landed, not the last one attempted', () => {
    let now = 1_000_000;
    const cadence = new SaveCadence({
      minItems: 10,
      db: { getLastSavedBytes: () => LIVE_SIZE },
      now: () => now
    });
    const items = (count: number): void => {
      for (let i = 0; i < count; i++) {
        now += LIVE_MS_PER_ITEM;
        cadence.recordItem();
      }
    };

    items(MAX_ITEMS_AT_RISK);
    expect(cadence.shouldSave()).toBe(true);

    cadence.markSaveAttempt();
    expect(cadence.itemsAtRisk()).toBe(MAX_ITEMS_AT_RISK);

    cadence.markSaveSuccess();
    cadence.markSaveAttempt();
    expect(cadence.itemsAtRisk()).toBe(0);

    items(MAX_ITEMS_AT_RISK - 1);
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
