import { DreamConsolidationService, DreamDeps } from '../../src/services/embeddings/adapter/DreamConsolidationService';
import { RetrievalTraceRecord, FeedbackEmbeddingProvider } from '../../src/services/embeddings/adapter/RetrievalFeedbackMiner';
import { EmbeddingAdapter } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const swap = (q: Float32Array) => new Float32Array([q[1], q[0]]);

/**
 * Build a fake feedback world. `relevance` decides whether the used note is
 * the axis-SWAP of the query (identity cannot rank it first — must be learned)
 * or EQUAL to the query (identity is already optimal — nothing to learn).
 */
function buildWorld(n: number, relevance: 'swap' | 'identity-optimal', seed = 9) {
  const r = rng(seed);
  const queries: Record<string, Float32Array> = {};
  const docs: Record<string, Float32Array> = {};
  const records: RetrievalTraceRecord[] = [];

  for (let i = 0; i < n; i++) {
    const theta = r() * Math.PI * 2;
    const q = new Float32Array([Math.cos(theta), Math.sin(theta)]);
    const match = relevance === 'swap' ? swap(q) : new Float32Array([q[0], q[1]]);
    const distract = relevance === 'swap'
      ? new Float32Array([q[0], q[1]])               // = q; identity ranks it ABOVE swap-match
      : new Float32Array([-q[1], q[0]]);             // orthogonal; identity ranks BELOW match

    queries[`q${i}`] = q;
    docs[`match${i}`] = match;
    docs[`distract${i}`] = distract;

    records.push({
      sessionId: `s${i}`, workspaceId: 'w', timestamp: i * 2, agent: 'searchManager', mode: 'content',
      query: `q${i}`,
      retrieval: { groupId: `g${i}`, candidates: [{ path: `match${i}` }, { path: `distract${i}` }] }
    });
    records.push({
      sessionId: `s${i}`, workspaceId: 'w', timestamp: i * 2 + 1, agent: 'contentManager', mode: 'read',
      usedPaths: [`match${i}`]
    });
  }

  const embeddings: FeedbackEmbeddingProvider = {
    embedQuery: async (k) => queries[k] ?? null,
    getDocVector: async (p) => docs[p] ?? null
  };
  return { records, embeddings, docs, queries };
}

function makeDeps(over: Partial<DreamDeps> & Pick<DreamDeps, 'getTraceRecords' | 'embeddings'>): {
  deps: DreamDeps; applied: EmbeddingAdapter[]; save: jest.Mock;
} {
  const applied: EmbeddingAdapter[] = [];
  const save = jest.fn().mockResolvedValue(undefined);
  const deps: DreamDeps = {
    store: { load: async () => EmbeddingAdapter.identity(2), save },
    applyAdapter: (a) => applied.push(a),
    config: {
      minExamples: 20, holdoutFraction: 0.25,
      train: { rank: 4, alpha: 1, epochs: 200, learningRate: 0.3, temperature: 0.1, seed: 3 },
      promotion: { mrrMargin: 0.05, coverageFloor: 0.5 }
    },
    ...over
  };
  return { deps, applied, save };
}

describe('DreamConsolidationService', () => {
  it('END-TO-END: mines feedback, trains, promotes, and the applied adapter re-ranks the used note to #1', async () => {
    const world = buildWorld(40, 'swap');
    const { deps, applied, save } = makeDeps({
      getTraceRecords: async () => world.records,
      embeddings: world.embeddings
    });
    const service = new DreamConsolidationService(deps);

    const report = await service.runDreamCycle();

    // The loop ran and produced a better retriever.
    expect(report.minedExamples).toBe(40);
    expect(report.trained).toBe(true);
    expect(report.promoted).toBe(true);
    expect(report.mrrBefore).toBeCloseTo(0.5, 1);   // identity is stuck at ~0.5 here
    expect(report.mrrAfter).toBeGreaterThan(0.9);
    expect(save).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
    expect(applied[0].isIdentity).toBe(false);

    // Prove the applied adapter actually fixes ranking on a FRESH query:
    // identity puts the distractor first; the learned adapter puts the match first.
    // (Asymmetric query so swap(q) ≠ q.)
    const q = new Float32Array([0.8944, 0.4472]);
    const match = swap(q);
    const distract = new Float32Array([q[0], q[1]]);
    const dot = (a: Float32Array, b: Float32Array) => a[0] * b[0] + a[1] * b[1];

    expect(dot(q, match)).toBeLessThan(dot(q, distract)); // identity: distractor wins
    const adapted = applied[0].transform(q);
    expect(dot(adapted, match)).toBeGreaterThan(dot(adapted, distract)); // adapter: match wins
  });

  it('does not promote (or apply) when there is nothing to improve', async () => {
    const world = buildWorld(40, 'identity-optimal');
    const { deps, applied, save } = makeDeps({
      getTraceRecords: async () => world.records,
      embeddings: world.embeddings
    });
    const report = await new DreamConsolidationService(deps).runDreamCycle();

    expect(report.trained).toBe(true);
    expect(report.promoted).toBe(false);
    expect(report.mrrBefore).toBeGreaterThan(0.9); // identity already optimal
    expect(save).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0); // live adapter untouched
  });

  it('skips the cycle on insufficient data without touching the live adapter', async () => {
    const world = buildWorld(5, 'swap');
    const { deps, applied, save } = makeDeps({
      getTraceRecords: async () => world.records,
      embeddings: world.embeddings
    });
    const report = await new DreamConsolidationService(deps).runDreamCycle();

    expect(report.promoted).toBe(false);
    expect(report.reason).toBe('insufficient-data');
    expect(save).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
  });
});
