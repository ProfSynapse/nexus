jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

describe('HybridStorageAdapter', () => {
  describe('reconcileMissingConversations', () => {
    it('replays missing conversation JSONL files into SQLite cache', async () => {
      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        jsonlWriter: {
          listFiles: jest.Mock<Promise<string[]>, [string]>;
          readEvents: jest.Mock<Promise<Array<{ type: string; timestamp: number }>>, [string]>;
        };
        conversationRepo: {
          getById: jest.Mock<Promise<null>, [string]>;
        };
        sqliteCache: {
          save: jest.Mock<Promise<void>, []>;
        };
        reconcileMissingConversations: () => Promise<void>;
      };

      adapter.jsonlWriter = {
        listFiles: jest.fn().mockResolvedValue(['conversations/conv_desktop-sync.jsonl']),
        readEvents: jest.fn().mockResolvedValue([
          { type: 'message', timestamp: 20 },
          { type: 'metadata', timestamp: 10 },
          { type: 'message_updated', timestamp: 30 }
        ])
      };
      adapter.conversationRepo = {
        getById: jest.fn().mockResolvedValue(null)
      };
      adapter.sqliteCache = {
        save: jest.fn().mockResolvedValue(undefined)
      };

      const applySpy = jest
        .spyOn(ConversationEventApplier.prototype, 'apply')
        .mockResolvedValue(undefined);

      try {
        await adapter.reconcileMissingConversations();

        expect(adapter.jsonlWriter.listFiles).toHaveBeenCalledWith('conversations');
        expect(adapter.conversationRepo.getById).toHaveBeenCalledWith('desktop-sync');
        expect(applySpy).toHaveBeenCalledTimes(3);
        expect(applySpy.mock.calls[0][0]).toMatchObject({ type: 'metadata', timestamp: 10 });
        expect(applySpy.mock.calls[1][0]).toMatchObject({ type: 'message', timestamp: 20 });
        expect(applySpy.mock.calls[2][0]).toMatchObject({ type: 'message_updated', timestamp: 30 });
        expect(adapter.sqliteCache.save).toHaveBeenCalledTimes(1);
      } finally {
        applySpy.mockRestore();
      }
    });
  });
});
