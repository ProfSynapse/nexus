/**
 * WorkbookAutoMirror — forward auto-mirror scheduling: path filtering (source
 * `.xlsx`/`.xlsm` outside the mirror tree), debounce coalescing, and post-run
 * cooldown that absorbs the write-back's re-entrant `.xlsx` modify. The actual
 * mirror is injected; timers run on a manual fake clock for determinism.
 */

import { WorkbookAutoMirror } from '../../src/agents/apps/dataAnalysis/spreadsheet/WorkbookAutoMirror';

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
      await Promise.resolve();
    },
  };
}

describe('WorkbookAutoMirror.isWorkbookPath', () => {
  const am = new WorkbookAutoMirror({ getRoot: () => 'Nexus', mirror: async () => undefined });

  it('matches source .xlsx/.xlsm anywhere outside the mirror tree', () => {
    expect(am.isWorkbookPath('budget.xlsx')).toBe(true);
    expect(am.isWorkbookPath('data/q1.xlsm')).toBe(true);
    expect(am.isWorkbookPath('Attachments/Report.XLSX')).toBe(true);
  });

  it('ignores non-workbooks, the mirror itself, and snapshots', () => {
    expect(am.isWorkbookPath('notes/journal.md')).toBe(false);
    expect(am.isWorkbookPath('data/legacy.xls')).toBe(false); // .xls not supported by hucre source
    expect(am.isWorkbookPath('Nexus/spreadsheets/budget/Data.part0.csv')).toBe(false);
    expect(am.isWorkbookPath('Nexus/spreadsheets/budget/source.xlsx')).toBe(false); // inside mirror
    expect(am.isWorkbookPath('vault/_archive/old.xlsx')).toBe(false);
  });
});

describe('WorkbookAutoMirror scheduling', () => {
  it('debounces a burst of changes into a single mirror', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const am = new WorkbookAutoMirror({
      getRoot: () => 'Nexus',
      mirror: async (p) => { calls.push(p); },
      debounceMs: 1000,
      ...clock,
    });

    am.notifyChanged('budget.xlsx');
    am.notifyChanged('budget.xlsx');
    am.notifyChanged('budget.xlsx');
    await clock.advance(1000);

    expect(calls).toEqual(['budget.xlsx']);
  });

  it('suppresses the re-entrant .xlsx modify during the cooldown window', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const am = new WorkbookAutoMirror({
      getRoot: () => 'Nexus',
      mirror: async (p) => { calls.push(p); },
      debounceMs: 1000,
      cooldownMs: 800,
      ...clock,
    });

    am.notifyChanged('budget.xlsx');
    await clock.advance(1000); // first mirror runs
    expect(calls).toEqual(['budget.xlsx']);

    // The write-back's re-projection re-writes the .xlsx → modify event inside cooldown.
    am.notifyChanged('budget.xlsx');
    await clock.advance(500); // still within 800ms cooldown
    expect(calls).toEqual(['budget.xlsx']); // ignored — no second mirror

    // After the cooldown, a genuine edit mirrors again.
    await clock.advance(400); // now past cooldown
    am.notifyChanged('budget.xlsx');
    await clock.advance(1000);
    expect(calls).toEqual(['budget.xlsx', 'budget.xlsx']);
  });

  it('mirrors distinct workbooks independently', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const am = new WorkbookAutoMirror({
      getRoot: () => 'Nexus',
      mirror: async (p) => { calls.push(p); },
      debounceMs: 1000,
      ...clock,
    });

    am.notifyChanged('a.xlsx');
    am.notifyChanged('b.xlsx');
    await clock.advance(1000);

    expect(calls.sort()).toEqual(['a.xlsx', 'b.xlsx']);
  });

  it('dispose cancels pending mirrors', async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const am = new WorkbookAutoMirror({
      getRoot: () => 'Nexus',
      mirror: async (p) => { calls.push(p); },
      debounceMs: 1000,
      ...clock,
    });

    am.notifyChanged('budget.xlsx');
    am.dispose();
    await clock.advance(5000);

    expect(calls).toEqual([]);
  });
});
