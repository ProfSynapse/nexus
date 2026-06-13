/**
 * SPIKE (throwaway gut-check, not production) for docs/plans/agent-steering-nudge-plan.md Phase 0.
 *
 * Tests the two riskiest assumptions on synthetic data BEFORE building anything:
 *   GC-1: is success-weighted next-tool prediction good enough to be worth it?
 *         (absolute top-1 accuracy is the decision-relevant number — low accuracy
 *          ⇒ worded nudges are net-harmful, ship prefetch-only.)
 *   GC-2: does the anti-farming reward gating drive a reward-farmer to ~0 while
 *         paying genuine work — including a farmer that SPOOFS provenance?
 *
 * Numbers are printed; assertions encode only the robust falsification gates.
 */

const TOOLS = ['search', 'read', 'list', 'getProperty', 'searchMemory', 'createTask', 'updateTask', 'write'];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

interface Session { tools: string[]; success: boolean; }

/**
 * Generate sessions. Successful sessions follow 3 workflow templates with a
 * genuinely AMBIGUOUS exploit step (so accuracy can't be ~100%). Noise sessions
 * wander over OVERLAPPING states (so they actively pollute a raw-frequency model).
 */
function generateSessions(n: number, seed: number): Session[] {
  const r = rng(seed);
  const out: Session[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.6) {
      // successful
      const t = r();
      let tools: string[];
      if (t < 0.4) {
        tools = ['search', 'read', r() < 0.6 ? 'createTask' : 'write']; // ambiguous exploit
      } else if (t < 0.75) {
        tools = ['search', 'searchMemory', 'read', 'updateTask'];
      } else {
        tools = ['list', 'read', 'getProperty', 'write'];
      }
      out.push({ tools, success: true });
    } else {
      // noise: starts on overlapping states, wanders, never a clean exploit
      const len = 3 + Math.floor(r() * 4);
      const tools = [r() < 0.5 ? 'search' : 'list'];
      const wander = ['search', 'list', 'searchMemory', 'getProperty'];
      for (let k = 1; k < len; k++) tools.push(pick(r, wander));
      out.push({ tools, success: false });
    }
  }
  return out;
}

type Bigram = Map<string, Map<string, number>>;

function buildBigram(sessions: Session[], successOnly: boolean): Bigram {
  const m: Bigram = new Map();
  for (const s of sessions) {
    const w = successOnly ? (s.success ? 1 : 0) : 1;
    if (w === 0) continue;
    for (let i = 0; i + 1 < s.tools.length; i++) {
      const [a, b] = [s.tools[i], s.tools[i + 1]];
      if (!m.has(a)) m.set(a, new Map());
      const row = m.get(a)!;
      row.set(b, (row.get(b) ?? 0) + w);
    }
  }
  return m;
}

const argmax = (row: Map<string, number> | undefined): string | null => {
  if (!row) return null;
  let best: string | null = null, bv = -1;
  for (const [k, v] of row) if (v > bv) { bv = v; best = k; }
  return best;
};

function majorityNext(sessions: Session[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) for (let i = 1; i < s.tools.length; i++) counts.set(s.tools[i], (counts.get(s.tools[i]) ?? 0) + 1);
  return argmax(counts) ?? TOOLS[0];
}

/** Top-1 next-tool accuracy over transitions in held-out SUCCESSFUL sessions. */
function accuracy(model: Bigram, fallback: string, test: Session[]): number {
  let hit = 0, total = 0;
  for (const s of test) {
    if (!s.success) continue;
    for (let i = 0; i + 1 < s.tools.length; i++) {
      const pred = argmax(model.get(s.tools[i])) ?? fallback;
      if (pred === s.tools[i + 1]) hit++;
      total++;
    }
  }
  return total === 0 ? 0 : hit / total;
}

describe('SPIKE: steering gut-checks (Phase 0)', () => {
  it('GC-1: next-tool predictability and the value of success-weighting', () => {
    const all = generateSessions(400, 1);
    const cut = Math.floor(all.length * 0.7);
    const train = all.slice(0, cut);
    const test = all.slice(cut);

    const majority = majorityNext(train);
    const successWeighted = accuracy(buildBigram(train, true), majority, test);
    const rawFrequency = accuracy(buildBigram(train, false), majority, test);
    const baseline = accuracy(new Map(), majority, test); // always predict majority class

    // eslint-disable-next-line no-console
    console.log('\n[GC-1] held-out top-1 next-tool accuracy:', {
      successWeighted: +successWeighted.toFixed(3),
      rawFrequency: +rawFrequency.toFixed(3),
      majorityBaseline: +baseline.toFixed(3)
    });

    // GC-1b: the average is misleading — the design confidence-GATES. Report
    // accuracy vs coverage as we raise the confidence threshold. This is what
    // actually decides whether a worded nudge is ever safe.
    const model = buildBigram(train, true);
    const pairs: Array<{ conf: number; correct: boolean }> = [];
    for (const s of test) {
      if (!s.success) continue;
      for (let i = 0; i + 1 < s.tools.length; i++) {
        const row = model.get(s.tools[i]);
        const pred = argmax(row) ?? majority;
        let conf = 0;
        if (row) {
          let tot = 0, top = 0;
          for (const v of row.values()) { tot += v; if (v > top) top = v; }
          conf = tot > 0 ? top / tot : 0;
        }
        pairs.push({ conf, correct: pred === s.tools[i + 1] });
      }
    }
    const at = (thr: number) => {
      const sel = pairs.filter(p => p.conf >= thr);
      return {
        coverage: +(sel.length / pairs.length).toFixed(2),
        accuracy: sel.length ? +(sel.filter(p => p.correct).length / sel.length).toFixed(2) : 0
      };
    };
    // eslint-disable-next-line no-console
    console.log('[GC-1b] confidence-gated (acc @ coverage):', { '>=0.5': at(0.5), '>=0.7': at(0.7), '>=0.9': at(0.9) });

    // Falsification gates (robust): the predictor must beat the majority baseline,
    // and success-weighting must not be WORSE than raw-frequency.
    expect(successWeighted).toBeGreaterThan(baseline);
    expect(successWeighted).toBeGreaterThanOrEqual(rawFrequency - 1e-9);
    // NOTE: absolute accuracy is the real decision number — see console + report.
  });

  it('GC-2: reward gating zeroes the farmer (incl. provenance spoof) but pays genuine work', () => {
    interface Task {
      createdByAgent: boolean; createdSession: string; completedSession: string;
      claimedUserCreated: boolean; descriptionLen: number; dependencies: number;
      steps: number; outputUsedDownstream: boolean;
      /** Ground-truth creation provenance from an agent-UNWRITABLE channel. */
      observedUserCreated: boolean;
    }

    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

    function reward(t: Task): number {
      // Hard zero: agent self-created AND completed in the same session.
      // Uses the OBSERVED creation event, so claimedUserCreated spoofing is ignored.
      if (t.createdByAgent && t.createdSession === t.completedSession) return 0;
      const substance = clamp01((t.descriptionLen / 120) * (1 + t.dependencies) * Math.min(t.steps, 5) / 5);
      const causalUse = t.outputUsedDownstream ? 1 : 0.1;
      const provenance = t.observedUserCreated ? 1 : 0.5; // unwritable channel, not the claim
      return substance * causalUse * provenance;
    }

    const genuine: Task = {
      createdByAgent: false, createdSession: 's0', completedSession: 's3',
      claimedUserCreated: true, observedUserCreated: true,
      descriptionLen: 180, dependencies: 2, steps: 5, outputUsedDownstream: true
    };
    const farmerBasic: Task = {
      createdByAgent: true, createdSession: 's7', completedSession: 's7',
      claimedUserCreated: false, observedUserCreated: false,
      descriptionLen: 0, dependencies: 0, steps: 1, outputUsedDownstream: false
    };
    const farmerSneaky: Task = { // mislabels itself as user-created
      ...farmerBasic, claimedUserCreated: true
    };

    const rGenuine = reward(genuine);
    const rBasic = reward(farmerBasic);
    const rSneaky = reward(farmerSneaky);
    // eslint-disable-next-line no-console
    console.log('[GC-2] rewards:', { genuine: +rGenuine.toFixed(3), farmerBasic: rBasic, farmerSneaky: rSneaky });

    expect(rBasic).toBe(0);
    expect(rSneaky).toBe(0); // provenance spoof does not help — same-session guard catches it
    expect(rGenuine).toBeGreaterThan(0.5);
    expect(rGenuine).toBeGreaterThan(rSneaky * 100 + 0.1);
  });
});
