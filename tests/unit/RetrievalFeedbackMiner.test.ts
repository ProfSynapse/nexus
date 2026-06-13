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

const search = (over: Partial<RetrievalTraceRecord>): RetrievalTraceRecord => ({
  sessionId: 's1', workspaceId: 'w1', timestamp: 1, agent: 'searchManager', mode: 'content',
  query: 'q', retrieval: { groupId: 'g1', candidates: [{ path: 'A' }, { path: 'B' }, { path: 'C' }] },
  ...over
});

const use = (over: Partial<RetrievalTraceRecord>): RetrievalTraceRecord => ({
  sessionId: 's1', workspaceId: 'w1', timestamp: 2, agent: 'contentManager', mode: 'read',
  usedPaths: ['B'], ...over
});

const baseDocs = { A: v(1, 0), B: v(0, 1), C: v(-1, 0) };
const baseQueries = { q: v(0.5, 0.5) };

describe('RetrievalFeedbackMiner', () => {
  it('joins a search to a later in-session use (positive + hard negatives)', async () => {
    const miner = new RetrievalFeedbackMiner(provider(baseQueries, baseDocs));
    const out = await miner.mine([search({}), use({})]);

    expect(out).toHaveLength(1);
    expect(out[0].positiveId).toBe('B');
    expect(out[0].candidates.map(c => c.id).sort()).toEqual(['A', 'B', 'C']);
    expect(out[0].weight).toBe(1);
  });

  it('produces no example when no candidate is used', async () => {
    const miner = new RetrievalFeedbackMiner(provider(baseQueries, baseDocs));
    const out = await miner.mine([search({}), use({ usedPaths: ['Z'] })]);
    expect(out).toHaveLength(0);
  });

  it('up-weights examples whose positive precedes a task completion', async () => {
    const miner = new RetrievalFeedbackMiner(provider(baseQueries, baseDocs), { taskRewardWeight: 3 });
    const out = await miner.mine([
      search({}),
      use({ timestamp: 2 }),
      { sessionId: 's1', workspaceId: 'w1', timestamp: 3, agent: 'taskManager', mode: 'updateTask', taskCompleted: true }
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].weight).toBe(3);
  });

  it('does not join a use from a different session', async () => {
    const miner = new RetrievalFeedbackMiner(provider(baseQueries, baseDocs));
    const out = await miner.mine([search({}), use({ sessionId: 's2' })]);
    expect(out).toHaveLength(0);
  });

  it('skips when the query or positive vector is unavailable', async () => {
    const miner = new RetrievalFeedbackMiner(provider({}, baseDocs)); // no query vec
    const out = await miner.mine([search({}), use({})]);
    expect(out).toHaveLength(0);
  });

  it('takes the first used candidate as the positive', async () => {
    const miner = new RetrievalFeedbackMiner(provider(baseQueries, baseDocs));
    const out = await miner.mine([
      search({}),
      use({ timestamp: 2, usedPaths: ['A'] }),
      use({ timestamp: 3, usedPaths: ['C'] })
    ]);
    expect(out[0].positiveId).toBe('A');
  });
});
