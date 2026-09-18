/**
 * Reasoning persistence — JSONL round-trip regression tests.
 *
 * JSONL is the source of truth and SQLite is a rebuildable cache, so anything
 * written only to the cache is gone after the next rebuild. Two things used to
 * be written that way:
 *
 *  - `MessageRepository.addMessage` put `reasoning` in the SQLite INSERT but
 *    left it out of the `message` event entirely.
 *  - `ConversationMigrator` did the same when converting legacy JSON, which
 *    dropped assistant thinking permanently on migration.
 *
 * And `reasoningSegments` — where in the answer each thought happened — had no
 * home at all until schema v17.
 */

import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';
import type { MessageEvent, MessageUpdatedEvent } from '../../src/database/interfaces/StorageEvents';

type SqliteCacheLike = {
  run: jest.Mock<Promise<void>, [string, unknown[]]>;
};

function makeApplier() {
  const sqliteCache = { run: jest.fn(async () => undefined) };
  return {
    sqliteCache,
    applier: new ConversationEventApplier(sqliteCache as SqliteCacheLike)
  };
}

/** Find the INSERT/UPDATE call that touched the messages table. */
function messageWrite(sqliteCache: SqliteCacheLike, pattern: RegExp) {
  const call = sqliteCache.run.mock.calls.find(([sql]) => pattern.test(sql));
  expect(call).toBeDefined();
  return { sql: call![0], params: call![1] };
}

const SEGMENTS = [
  { text: 'First thought', contentOffset: 0 },
  { text: 'Second thought', contentOffset: 9 }
];

describe('ConversationEventApplier — reasoning replay', () => {
  it('restores reasoning and its segments from a message event', async () => {
    const { applier, sqliteCache } = makeApplier();

    await applier.apply({
      id: 'evt-1',
      type: 'message',
      deviceId: 'device-1',
      timestamp: 111,
      conversationId: 'conv-1',
      data: {
        id: 'msg-1',
        role: 'assistant',
        content: 'Step one. Step two.',
        state: 'complete',
        sequenceNumber: 0,
        reasoning: 'First thoughtSecond thought',
        reasoning_segments: SEGMENTS
      }
    } as MessageEvent);

    const { sql, params } = messageWrite(sqliteCache, /INSERT OR REPLACE INTO messages/);

    // Column list and placeholder count must stay in step, or every replayed
    // message lands one column to the left.
    expect(sql).toContain('reasoningContent');
    expect(sql).toContain('reasoningSegmentsJson');
    const columnCount = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').length;
    expect(params).toHaveLength(columnCount);

    expect(params).toContain('First thoughtSecond thought');
    expect(params).toContain(JSON.stringify(SEGMENTS));
  });

  it('restores reasoning and its segments from a message_updated event', async () => {
    const { applier, sqliteCache } = makeApplier();

    await applier.apply({
      id: 'evt-2',
      type: 'message_updated',
      deviceId: 'device-1',
      timestamp: 222,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      data: {
        reasoning: 'First thoughtSecond thought',
        reasoning_segments: SEGMENTS
      }
    } as MessageUpdatedEvent);

    const { sql, params } = messageWrite(sqliteCache, /UPDATE messages/);

    expect(sql).toContain('reasoningContent = ?');
    expect(sql).toContain('reasoningSegmentsJson = ?');
    expect(params).toContain('First thoughtSecond thought');
    expect(params).toContain(JSON.stringify(SEGMENTS));
  });

  it('leaves segments NULL for a message that never recorded any', async () => {
    const { applier, sqliteCache } = makeApplier();

    await applier.apply({
      id: 'evt-3',
      type: 'message',
      deviceId: 'device-1',
      timestamp: 333,
      conversationId: 'conv-1',
      data: {
        id: 'msg-legacy',
        role: 'assistant',
        content: 'Answer',
        state: 'complete',
        sequenceNumber: 0,
        reasoning: 'Thinking with no recorded offsets'
      }
    } as MessageEvent);

    const { params } = messageWrite(sqliteCache, /INSERT OR REPLACE INTO messages/);

    expect(params).toContain('Thinking with no recorded offsets');
    // NULL, not '[]' — a pre-v17 row renders from the flat reasoning instead
    expect(params).toContain(null);
    expect(params).not.toContain('[]');
  });

  it('does not clobber stored segments when an update omits them', async () => {
    const { applier, sqliteCache } = makeApplier();

    await applier.apply({
      id: 'evt-4',
      type: 'message_updated',
      deviceId: 'device-1',
      timestamp: 444,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      data: { content: 'Only the text changed' }
    } as MessageUpdatedEvent);

    const { sql } = messageWrite(sqliteCache, /UPDATE messages/);

    expect(sql).toContain('content = ?');
    expect(sql).not.toContain('reasoningSegmentsJson');
    expect(sql).not.toContain('reasoningContent');
  });
});

describe('writers put reasoning in the JSONL event, not only in the cache', () => {
  // These read the source rather than driving the classes: MessageRepository
  // needs live SQLite + a JSONL writer, and ConversationMigrator needs a vault.
  // The failure being guarded against is a missing key in an object literal,
  // which a structural check catches exactly.
  const read = (path: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('fs') as typeof import('fs')).readFileSync(path, 'utf8');

  it('MessageRepository.addMessage writes reasoning to the message event', () => {
    const source = read('src/database/repositories/MessageRepository.ts');
    const event = source.slice(
      source.indexOf("type: 'message',"),
      source.indexOf('// 2. Update SQLite cache')
    );

    expect(event).toContain('reasoning: data.reasoning');
    expect(event).toContain('reasoning_segments: data.reasoningSegments');
  });

  it('ConversationMigrator carries reasoning into the migrated message event', () => {
    const source = read('src/database/migration/ConversationMigrator.ts');
    const event = source.slice(source.indexOf("type: 'message',"));

    expect(event).toContain('reasoning: message.reasoning');
  });
});
