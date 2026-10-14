/**
 * The conversation backfill must converge on the conversations that exist,
 * whatever order the cache filled in.
 *
 * Observed in a real vault: `embedding_backfill_state` said
 * {status: 'completed', totalConversations: 0}, the `conversations` table held
 * 53 rows, and `conversation_embedding_metadata` covered one of them. The
 * backfill had run once while the conversations table was still empty (a
 * cache that had not replayed its conversation events yet), recorded
 * 'completed', and every later start returned at the completed row before
 * looking at a single conversation. Chat history was never indexed.
 *
 * These run the real ConversationIndexer and the real
 * ConversationEmbeddingService against real SQLite (node:sqlite, in-memory)
 * with the production schema, so the anti-join and the idempotency check are
 * SQLite's, not a mock's. Only the embedding model is faked. Skipped where
 * node:sqlite does not exist (Node < 22.5).
 */

import { ConversationIndexer } from '../../src/services/embeddings/ConversationIndexer';
import { ConversationEmbeddingService } from '../../src/services/embeddings/ConversationEmbeddingService';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { EmbeddingEngine } from '../../src/services/embeddings/EmbeddingEngine';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { QAPair } from '../../src/services/embeddings/QAPairBuilder';

interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

function loadNodeSqlite(): (new (path: string) => NodeSqliteDb) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sqlite') as { DatabaseSync: new (path: string) => NodeSqliteDb }).DatabaseSync;
  } catch {
    return null;
  }
}

const DatabaseSync = loadNodeSqlite();
const describeWithSqlite = DatabaseSync ? describe : describe.skip;

/** Production schema; vec0 tables become plain tables with an embedding column. */
function openCache() {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA_SQL.replace(
    /CREATE VIRTUAL TABLE IF NOT EXISTS (\w+) USING vec0\([\s\S]*?\);/g,
    'CREATE TABLE IF NOT EXISTS $1 (rowid INTEGER PRIMARY KEY, embedding BLOB);'
  ));
  const params = (p: unknown[] = []) => p.map(v => (v === undefined ? null : v));
  const cache = {
    run: async (sql: string, p?: unknown[]) => { db.prepare(sql).run(...params(p)); },
    query: async <T>(sql: string, p?: unknown[]) => db.prepare(sql).all(...params(p)) as T[],
    queryOne: async <T>(sql: string, p?: unknown[]) => (db.prepare(sql).get(...params(p)) ?? null) as T | null,
    save: jest.fn(async () => undefined)
  };
  return { db, cache };
}

function createHarness() {
  const { db, cache } = openCache();
  const generateEmbedding = jest.fn(async () => new Float32Array(384));
  const engine = {
    generateEmbedding,
    getModelInfo: () => ({ id: 'test-model', dimensions: 384 })
  } as unknown as EmbeddingEngine;
  const conversationService = new ConversationEmbeddingService(
    cache as unknown as SQLiteCacheManager,
    engine
  );
  const embeddingService = {
    isServiceEnabled: () => true,
    embedConversationTurn: (pair: QAPair) => conversationService.embedConversationTurn(pair)
  } as unknown as EmbeddingService;

  const newIndexer = () => new ConversationIndexer(
    cache as unknown as SQLiteCacheManager,
    embeddingService,
    () => undefined
  );

  let seq = 0;
  const addConversation = (id: string, created: number, metadata?: Record<string, unknown>) => {
    db.prepare(
      `INSERT INTO conversations (id, title, created, updated, vaultName, metadataJson, workspaceId, sessionId)
       VALUES (?, ?, ?, ?, 'vault', ?, 'ws-1', 'sess-1')`
    ).run(id, `Conversation ${id}`, created, created, metadata ? JSON.stringify(metadata) : null);
  };
  const addTurn = (conversationId: string, question: string, answer: string) => {
    for (const [role, content] of [['user', question], ['assistant', answer]] as const) {
      seq++;
      db.prepare(
        `INSERT INTO messages (id, conversationId, role, content, timestamp, state, sequenceNumber)
         VALUES (?, ?, ?, ?, ?, 'complete', ?)`
      ).run(`${conversationId}-m${seq}`, conversationId, role, content, seq, seq);
    }
  };
  const indexedConversations = () => (db.prepare(
    'SELECT DISTINCT conversationId FROM conversation_embedding_metadata ORDER BY conversationId'
  ).all() as Array<{ conversationId: string }>).map(r => r.conversationId);
  const backfillRow = () => db.prepare(
    "SELECT * FROM embedding_backfill_state WHERE id = 'conversation_backfill'"
  ).get() as Record<string, unknown> | undefined;

  return { db, cache, generateEmbedding, newIndexer, addConversation, addTurn, indexedConversations, backfillRow };
}

describeWithSqlite('Conversation backfill convergence (real SQLite)', () => {
  it('does not record completion when the conversations table is empty', async () => {
    const h = createHarness();

    await h.newIndexer().start(null);

    expect(h.backfillRow()?.status).not.toBe('completed');

    // The conversations replay in afterwards; the next start indexes them.
    h.addConversation('conv-a', 1);
    h.addTurn('conv-a', 'How do I bake sourdough bread?', 'Feed the starter, then shape and proof.');
    h.addConversation('conv-b', 2);
    h.addTurn('conv-b', 'What is a good name for a cat?', 'Miso is a classic choice.');

    const result = await h.newIndexer().start(null);

    expect(result).toEqual({ total: 2, processed: 2 });
    expect(h.indexedConversations()).toEqual(['conv-a', 'conv-b']);
    expect(h.backfillRow()?.status).toBe('completed');
  });

  it('heals a vault already stuck at completed-with-zero on the next start', async () => {
    const h = createHarness();
    // The exact row found in the real vault.
    h.db.prepare(
      `INSERT INTO embedding_backfill_state
         (id, lastProcessedConversationId, totalConversations, processedConversations, status, startedAt, completedAt, errorMessage)
       VALUES ('conversation_backfill', NULL, 0, 0, 'completed', 1791040641446, 1791040641446, NULL)`
    ).run();
    h.addConversation('conv-old', 1);
    h.addTurn('conv-old', 'Plan the garden layout for spring', 'Tomatoes along the south fence.');
    h.addConversation('conv-new', 2);
    h.addTurn('conv-new', 'Draft the quarterly budget email', 'Here is a draft with the totals.');
    h.addConversation('conv-branch', 3, { parentConversationId: 'conv-new' });
    h.addTurn('conv-branch', 'Branch question that is long enough', 'Branch answer that is long enough');

    const result = await h.newIndexer().start(null);

    expect(result).toEqual({ total: 2, processed: 2 });
    expect(h.indexedConversations()).toEqual(['conv-new', 'conv-old']);
    const row = h.backfillRow();
    expect(row?.status).toBe('completed');
    expect(row?.totalConversations).toBe(2);
  });

  it('indexes only the missing conversations after completion, and re-embeds nothing', async () => {
    const h = createHarness();
    h.addConversation('conv-1', 1);
    h.addTurn('conv-1', 'First conversation question here', 'First conversation answer here');

    await h.newIndexer().start(null);
    expect(h.indexedConversations()).toEqual(['conv-1']);
    expect(h.backfillRow()?.status).toBe('completed');
    const embedsAfterFirstRun = h.generateEmbedding.mock.calls.length;

    // A conversation that reaches the cache after the backfill completed
    // (replayed later, or synced from another device).
    h.addConversation('conv-2', 2);
    h.addTurn('conv-2', 'Second conversation question here', 'Second conversation answer here');

    const result = await h.newIndexer().start(null);

    expect(result).toEqual({ total: 1, processed: 1 });
    expect(h.indexedConversations()).toEqual(['conv-1', 'conv-2']);
    // conv-1 was not touched again: only conv-2's two sides were embedded.
    expect(h.generateEmbedding.mock.calls.length - embedsAfterFirstRun).toBe(2);

    // A start with nothing missing writes nothing and embeds nothing.
    h.cache.save.mockClear();
    const embedsBefore = h.generateEmbedding.mock.calls.length;
    const idle = await h.newIndexer().start(null);
    expect(idle).toEqual({ total: 0, processed: 0 });
    expect(h.generateEmbedding.mock.calls.length).toBe(embedsBefore);
    expect(h.cache.save).not.toHaveBeenCalled();
  });

  it('skips conversations with no messages in the catch-up', async () => {
    const h = createHarness();
    h.addConversation('conv-1', 1);
    h.addTurn('conv-1', 'Question with an actual answer', 'The answer to the question');
    await h.newIndexer().start(null);

    h.addConversation('conv-empty', 2);

    const result = await h.newIndexer().start(null);

    expect(result).toEqual({ total: 0, processed: 0 });
  });
});
