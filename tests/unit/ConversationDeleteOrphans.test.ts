/**
 * Regression test for the live conversation delete.
 *
 * `ConversationEventApplier.applyConversationDeleted` has always removed the
 * messages explicitly, but `ConversationRepository.delete` relied on the
 * `ON DELETE CASCADE` declared on `messages.conversationId`. FK enforcement is
 * off on this connection, so the cascade never fired: measured in a real vault,
 * deleting a 1-message conversation left `conversations 0, messages 1`, and the
 * orphan only disappeared at the next `rebuildCache()`.
 *
 * The conversation tombstone itself was already correct — the conversation does
 * not come back — so this is the live path catching up to the replay path.
 *
 * The second gap measured in the same run WAS deferred: the stream directory
 * `Nexus/data/conversations/conv_<id>/` survived both the delete and the
 * rebuild, because removing it needed the `deleteStream` chain that landed with
 * #347. That chain is on main now, so it is wired up here — the follow-up the
 * PR description promised.
 */

import { ConversationRepository } from '../../src/database/repositories/ConversationRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { createMockApp } from '../helpers/mockVaultAdapter';

const CONV = 'conv-target';

describe('ConversationRepository.delete', () => {
  function build() {
    const { app } = createMockApp({ withLocalStorage: true });
    const vaultEventStore = new VaultEventStore({
      app,
      resolution: { resolvedPath: 'Nexus', dataPath: 'Nexus/data', maxShardBytes: 4096 }
    });
    const jsonlWriter = new JSONLWriter({
      app,
      basePath: '.obsidian/plugins/nexus/data',
      readBasePaths: ['.obsidian/plugins/nexus/data'],
      vaultEventStore
    });
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const cache = {
      run: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        return undefined;
      }),
      query: jest.fn(async () => []),
      queryOne: jest.fn(async () => null),
      transaction: jest.fn((fn: () => Promise<unknown>) => fn())
    };
    const deps: RepositoryDependencies = {
      sqliteCache: cache as never,
      jsonlWriter,
      queryCache: new QueryCache()
    };
    return { deps, statements, vaultEventStore, jsonlWriter };
  }

  it('deletes the messages too, instead of trusting a cascade that never fires', async () => {
    const { deps, statements } = build();

    await new ConversationRepository(deps).delete(CONV);

    const deletes = statements.filter(s => /^\s*DELETE/i.test(s.sql));
    // Pre-fix this was the conversations row alone.
    expect(deletes.map(s => s.sql)).toEqual([
      expect.stringMatching(/DELETE FROM messages WHERE conversationId = \?/i),
      expect.stringMatching(/DELETE FROM conversations WHERE id = \?/i)
    ]);
    expect(deletes.every(s => s.params[0] === CONV)).toBe(true);
  });

  it('removes the conversation stream, which carries the messages too', async () => {
    const { deps, jsonlWriter, vaultEventStore } = build();
    await jsonlWriter.appendEvents(`conversations/conv_${CONV}.jsonl`, [
      { type: 'conversation_created', conversationId: CONV, data: { id: CONV, title: 'T' } },
      { type: 'message_added', conversationId: CONV, data: { id: 'msg-1', role: 'user', content: 'hi' } }
    ] as never);
    expect(await vaultEventStore.listFiles('conversations'))
      .toContain(`conversations/conv_${CONV}.jsonl`);

    await new ConversationRepository(deps).delete(CONV);

    // Pre-fix the directory survived the delete AND the rebuild: the tombstone
    // kept the rows out of the cache, but the source of truth was still there.
    expect(await vaultEventStore.listFiles('conversations'))
      .not.toContain(`conversations/conv_${CONV}.jsonl`);
  });

  it('writes the tombstone before removing the stream, so a failed removal still cancels out', async () => {
    const { deps, jsonlWriter } = build();
    const appendSpy = jest.spyOn(jsonlWriter, 'appendEvent');
    const removeSpy = jest.spyOn(jsonlWriter, 'deleteStream');

    await new ConversationRepository(deps).delete(CONV);

    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith(`conversations/conv_${CONV}.jsonl`);
    expect(appendSpy.mock.invocationCallOrder[0])
      .toBeLessThan(removeSpy.mock.invocationCallOrder[0]);
  });

  it('leaves the tombstone behind and does not touch SQLite when the stream cannot be removed', async () => {
    const { deps, jsonlWriter, vaultEventStore, statements } = build();
    jest.spyOn(jsonlWriter, 'deleteStream').mockRejectedValue(new Error('vault is locked'));

    await expect(new ConversationRepository(deps).delete(CONV))
      .rejects.toThrow('vault is locked');

    expect(statements.filter(s => /^\s*DELETE/i.test(s.sql))).toEqual([]);
    const events = await vaultEventStore.readEvents<{ type: string; conversationId?: string }>(
      `conversations/conv_${CONV}.jsonl`
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'conversation_deleted', conversationId: CONV })
    ]);
  });

  it('does not delete a sibling conversation stream', async () => {
    const { deps, jsonlWriter, vaultEventStore } = build();
    await jsonlWriter.appendEvents(`conversations/conv_bystander.jsonl`, [
      { type: 'conversation_created', conversationId: 'bystander', data: { id: 'bystander', title: 'B' } }
    ] as never);

    await new ConversationRepository(deps).delete(CONV);

    expect(await vaultEventStore.listFiles('conversations'))
      .toContain('conversations/conv_bystander.jsonl');
  });
});
