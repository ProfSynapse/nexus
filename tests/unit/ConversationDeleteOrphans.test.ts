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
    return { deps, statements, vaultEventStore };
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

  it('still writes the tombstone first, so the delete survives a rebuild', async () => {
    const { deps, vaultEventStore } = build();

    await new ConversationRepository(deps).delete(CONV);

    const events = await vaultEventStore.readEvents<{ type: string; conversationId?: string }>(
      `conversations/conv_${CONV}.jsonl`
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'conversation_deleted', conversationId: CONV })
    ]);
  });
});
