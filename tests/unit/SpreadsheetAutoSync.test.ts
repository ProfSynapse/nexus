/**
 * SpreadsheetAutoSync — scheduling logic: path filtering, debounce coalescing,
 * and self-write (re-projection) loop suppression. The actual sync is injected,
 * and timers are driven by a manual fake clock so the tests are deterministic.
 */

import { SpreadsheetAutoSync } from '../../src/agents/apps/dataAnalysis/spreadsheet/SpreadsheetAutoSync';
import { dataToCsv } from '../../src/agents/apps/dataAnalysis/spreadsheet/csv';

/** Minimal manual timer + clock so debounce/cooldown are deterministic. */
function fakeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map<number, { fire: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = seq++;
      timers.set(id, { fire: now + ms, fn });
      return id;
    },
    clearTimer: (h: number) => { timers.delete(h); },
    advance: async (ms: number) => {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.fire <= now).sort((a, b) => a[1].fire - b[1].fire);
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
      await Promise.resolve();
    },
  };
}

describe('SpreadsheetAutoSync.workbookIdOf', () => {
  const sync = new SpreadsheetAutoSync({ getRoot: () => 'Nexus', sync: async () => undefined });

  it('matches mirror CSV shards and extracts the workbook id', () => {
    expect(sync.workbookIdOf('Nexus/spreadsheets/budget/Data.part0.csv')).toBe('budget');
  });
  it('ignores manifest.json, non-mirror paths, and snapshot shards', () => {
    expect(sync.workbookIdOf('Nexus/spreadsheets/budget/manifest.json')).toBeNull();
    expect(sync.workbookIdOf('Nexus/spreadsheets/budget/_archive/x/Data.part0.csv')).toBeNull();
    expect(sync.workbookIdOf('OtherFolder/budget/Data.part0.csv')).toBeNull();
    expect(sync.workbookIdOf('Nexus/spreadsheets/budget.xlsx')).toBeNull();
  });
});

describe('SpreadsheetAutoSync scheduling', () => {
  it('debounces a burst of edits into a single sync', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const sync = new SpreadsheetAutoSync({
      getRoot: () => 'Nexus',
      sync: async (id) => { calls.push(id); },
      debounceMs: 1000,
      ...clock,
    });

    sync.notifyModified('Nexus/spreadsheets/budget/Data.part0.csv');
    await clock.advance(400);
    sync.notifyModified('Nexus/spreadsheets/budget/Data.part1.csv'); // resets debounce
    await clock.advance(400);
    expect(calls).toEqual([]); // not yet
    await clock.advance(700); // 1000ms since last edit
    expect(calls).toEqual(['budget']); // coalesced into one
  });

  it('suppresses re-projection writes during sync + cooldown (no loop)', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const sync = new SpreadsheetAutoSync({
      getRoot: () => 'Nexus',
      // The sync itself "writes" a shard (re-projection) — must NOT re-trigger.
      sync: async (id) => {
        calls.push(id);
        sync.notifyModified('Nexus/spreadsheets/budget/Data.part0.csv');
      },
      debounceMs: 1000,
      cooldownMs: 500,
      ...clock,
    });

    sync.notifyModified('Nexus/spreadsheets/budget/Data.part0.csv');
    await clock.advance(1000); // fire sync #1 (which self-writes during run)
    await clock.advance(2000); // let any spurious debounce elapse
    expect(calls).toEqual(['budget']); // exactly one — no loop
  });
});

describe('dataToCsv (runPython CSV output)', () => {
  it('serializes array-of-records with a header row', () => {
    expect(dataToCsv([{ region: 'EMEA', amount: 100 }, { region: 'APAC', amount: 200 }]))
      .toBe('region,amount\nEMEA,100\nAPAC,200\n');
  });
  it('serializes array-of-arrays verbatim and array-of-scalars as one column', () => {
    expect(dataToCsv([['a', 'b'], [1, 2]])).toBe('a,b\n1,2\n');
    expect(dataToCsv([1, 2, 3])).toBe('1\n2\n3\n');
  });
  it('throws on a non-tabular result', () => {
    expect(() => dataToCsv({ total: 5 })).toThrow(/list of rows/);
  });
});
