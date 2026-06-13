import { TraceFeedbackSource, MemoryTraceQuery } from '../../src/services/embeddings/adapter/RetrievalFeedbackSources';

function dbReturning(rows: unknown[]): MemoryTraceQuery {
  return { query: jest.fn().mockResolvedValue(rows) };
}

const row = (sessionId: string, timestamp: number, metadata: unknown) => ({
  sessionId, workspaceId: 'w', timestamp, metadataJson: JSON.stringify(metadata)
});

describe('TraceFeedbackSource', () => {
  it('maps a direct semantic search trace into a retrieval record', async () => {
    const db = dbReturning([
      row('s1', 10, {
        tool: { agent: 'searchManager', mode: 'content' },
        input: { arguments: { query: 'graph theory' } },
        outcome: { success: true, retrieval: { groupId: 'g1', candidates: [{ path: 'A.md' }, { path: 'B.md' }] } }
      })
    ]);

    const [rec] = await new TraceFeedbackSource(db).getRecords();

    expect(rec.agent).toBe('searchManager');
    expect(rec.query).toBe('graph theory');
    expect(rec.retrieval).toEqual({ groupId: 'g1', candidates: [{ path: 'A.md' }, { path: 'B.md' }] });
  });

  it('maps a direct read trace into a use record (from input.files)', async () => {
    const db = dbReturning([
      row('s1', 20, {
        tool: { agent: 'contentManager', mode: 'read' },
        input: { arguments: { filePath: 'B.md' }, files: ['B.md'] },
        outcome: { success: true }
      })
    ]);

    const [rec] = await new TraceFeedbackSource(db).getRecords();

    expect(rec.mode).toBe('read');
    expect(rec.usedPaths).toEqual(['B.md']);
    expect(rec.retrieval).toBeUndefined();
  });

  it('expands a useTools batch into one record per sub-call', async () => {
    const db = dbReturning([
      row('s1', 30, {
        tool: { agent: 'toolManager', mode: 'useTools' },
        batch: {
          results: [
            { agent: 'searchManager', tool: 'content', params: { query: 'q' }, groupId: 'g9', candidates: [{ path: 'A.md' }, { path: 'B.md' }] },
            { agent: 'contentManager', tool: 'read', params: { path: 'B.md' } }
          ]
        }
      })
    ]);

    const recs = await new TraceFeedbackSource(db).getRecords();

    expect(recs).toHaveLength(2);
    expect(recs[0].retrieval).toEqual({ groupId: 'g9', candidates: [{ path: 'A.md' }, { path: 'B.md' }] });
    expect(recs[0].query).toBe('q');
    expect(recs[1].usedPaths).toEqual(['B.md']);
  });

  it('flags task completion from a taskManager done transition', async () => {
    const db = dbReturning([
      row('s1', 40, {
        tool: { agent: 'taskManager', mode: 'updateTask' },
        input: { arguments: { status: 'done' } },
        outcome: { success: true }
      })
    ]);

    const [rec] = await new TraceFeedbackSource(db).getRecords();
    expect(rec.taskCompleted).toBe(true);
  });

  it('skips unparseable rows without throwing', async () => {
    const db: MemoryTraceQuery = {
      query: jest.fn().mockResolvedValue([
        { sessionId: 's1', workspaceId: 'w', timestamp: 1, metadataJson: '{ broken' },
        row('s1', 2, { tool: { agent: 'searchManager', mode: 'content' }, input: { arguments: {} }, outcome: {} })
      ])
    };

    const recs = await new TraceFeedbackSource(db).getRecords();
    expect(recs).toHaveLength(1); // broken row dropped, valid row kept
  });

  it('returns [] when the query throws', async () => {
    const db: MemoryTraceQuery = { query: jest.fn().mockRejectedValue(new Error('no table')) };
    expect(await new TraceFeedbackSource(db).getRecords()).toEqual([]);
  });
});
