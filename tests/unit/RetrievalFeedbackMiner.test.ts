import {
  RetrievalFeedbackMiner,
  RetrievalTraceRecord,
  FeedbackEmbeddingProvider
} from '../../src/services/embeddings/adapter/RetrievalFeedbackMiner';

const v = (...xs: number[]) => new Float32Array(xs);

function provider(
  queries: Record<string, Float32Array>,
  docs: Record<string, Float32Array>
): FeedbackEmbeddingProvider {
  return {
    embedQuery: async (q) => queries[q] ?? null,
    getDocVector: async (p) => docs[p] ?? null
  };
}

// Candidates are in retriever-ranked order (best first): A, B, C.
const search = (over: Partial<RetrievalTraceRecord> = {}): RetrievalTraceRecord => ({
  sessionId: 's1', workspaceId: 'w1', timestamp: 1, agent: 'searchManager', mode: 'content',
  query: 'q', retrieval: { groupId: 'g1', candidates: [{ path: 'A' }, { path: 'B' }, { path: 'C' }] },
  ...over
});

const use = (over: Partial<RetrievalTraceRecord> = {}): RetrievalTraceRecord => ({
  sessionId: 's1', workspaceId: 'w1', timestamp: 2, agent: 'contentManager', mode: 'read',
  usedPaths: ['B'], ...over
});

const docs = { A: v(1, 0), B: v(0, 1), C: v(-1, 0) };
const queries = { q: v(0.5, 0.5) };
const ids = (out: { candidates: { id: string }[] }) => out.candidates.map(c => c.id).sort();

describe('RetrievalFeedbackMiner', () => {
  it('keeps only higher-ranked candidates as negatives (skip-above)', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs));
    const out = await miner.mine([search(), use()]); // used B at rank 1

    expect(out).toHaveLength(1);
    expect(out[0].positiveId).toBe('B');
    expect(ids(out[0])).toEqual(['A', 'B']); // C (ranked below B) excluded
    expect(out[0].weight).toBe(1);
  });

  it('drops a rank-0 use as self-confirming (no contrastive signal)', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs));
    const out = await miner.mine([search(), use({ usedPaths: ['A'] })]); // A is already #1
    expect(out).toHaveLength(0);
  });

  it('weights a deeper-buried hit higher (exposure debias)', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs), { exposureStep: 0.5 });
    const out = await miner.mine([search(), use({ usedPaths: ['C'] })]); // used C at rank 2

    expect(out[0].positiveId).toBe('C');
    expect(ids(out[0])).toEqual(['A', 'B', 'C']); // A and B both ranked above C
    expect(out[0].weight).toBeCloseTo(1.5, 5); // 1 + (2-1)*0.5
  });

  it('produces no example when no candidate is used', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs));
    expect(await miner.mine([search(), use({ usedPaths: ['Z'] })])).toHaveLength(0);
  });

  it('up-weights examples whose positive precedes a task completion', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs), { taskRewardWeight: 3 });
    const out = await miner.mine([
      search(),
      use({ timestamp: 2 }), // used B at rank 1 (exposure weight 1)
      { sessionId: 's1', workspaceId: 'w1', timestamp: 3, agent: 'taskManager', mode: 'updateTask', taskCompleted: true }
    ]);

    expect(out[0].weight).toBe(3); // 1 * taskRewardWeight
  });

  it('caps any single example weight', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs), { taskRewardWeight: 100, maxWeight: 8 });
    const out = await miner.mine([
      search(),
      use({ timestamp: 2 }),
      { sessionId: 's1', workspaceId: 'w1', timestamp: 3, agent: 'taskManager', mode: 'updateTask', taskCompleted: true }
    ]);
    expect(out[0].weight).toBe(8);
  });

  it('does not join a use from a different session', async () => {
    const miner = new RetrievalFeedbackMiner(provider(queries, docs));
    expect(await miner.mine([search(), use({ sessionId: 's2' })])).toHaveLength(0);
  });

  it('skips when the query or positive vector is unavailable', async () => {
    const miner = new RetrievalFeedbackMiner(provider({}, docs)); // no query vec
    expect(await miner.mine([search(), use()])).toHaveLength(0);
  });
});
