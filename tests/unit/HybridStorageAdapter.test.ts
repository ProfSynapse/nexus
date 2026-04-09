jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });
jest.mock('../../src/database/storage/canonical/CanonicalNexusEventStore', () => ({
  CanonicalNexusEventStore: jest.fn()
}));

import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

describe('HybridStorageAdapter', () => {
  describe('applyStoragePlan', () => {
    it('routes event writes to the canonical root and SQLite to plugin data', () => {
      const mockCanonicalStore = { __canonicalStore: true };
      const { CanonicalNexusEventStore: MockCanonicalNexusEventStore } = jest.requireMock(
        '../../src/database/storage/canonical/CanonicalNexusEventStore'
      ) as {
        CanonicalNexusEventStore: jest.Mock;
      };
      MockCanonicalNexusEventStore.mockImplementation(() => mockCanonicalStore);

      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        applyStoragePlan: (plan: {
          canonicalWriteBasePath: string;
          legacyReadBasePaths: string[];
          pluginCacheDbPath: string;
          canonicalRoot: {
            resolvedRootPath: string;
            maxShardBytes: number;
          };
        }) => void;
        app: unknown;
        jsonlWriter: {
          setBasePath: jest.Mock<void, [string]>;
          setReadBasePaths: jest.Mock<void, [string[]]>;
          setCanonicalStore: jest.Mock<void, [unknown]>;
        };
        sqliteCache: {
          setDbPath: jest.Mock<void, [string]>;
        };
        basePath: string;
      };

      adapter.app = {};
      adapter.jsonlWriter = {
        setBasePath: jest.fn(),
        setReadBasePaths: jest.fn(),
        setCanonicalStore: jest.fn()
      };
      adapter.sqliteCache = {
        setDbPath: jest.fn()
      } as never;

      adapter.applyStoragePlan({
        canonicalWriteBasePath: 'Nexus',
        legacyReadBasePaths: [
          '.obsidian/plugins/claudesidian-mcp/data',
          '.nexus'
        ],
        pluginCacheDbPath: '.obsidian/plugins/claudesidian-mcp/data/cache.db',
        canonicalRoot: {
          resolvedRootPath: 'Nexus',
          maxShardBytes: 4 * 1024 * 1024
        }
      });

      expect(adapter.basePath).toBe('Nexus');
      expect(MockCanonicalNexusEventStore).toHaveBeenCalledWith({
        app: adapter.app,
        resolution: {
          resolvedRootPath: 'Nexus',
          maxShardBytes: 4 * 1024 * 1024
        }
      });
      expect(adapter.jsonlWriter.setCanonicalStore).toHaveBeenCalledWith(mockCanonicalStore);
      expect(adapter.jsonlWriter.setBasePath).toHaveBeenCalledWith('Nexus');
      expect(adapter.jsonlWriter.setReadBasePaths).toHaveBeenCalledWith([
        'Nexus',
        '.obsidian/plugins/claudesidian-mcp/data',
        '.nexus'
      ]);
      expect(adapter.sqliteCache.setDbPath).toHaveBeenCalledWith(
        '.obsidian/plugins/claudesidian-mcp/data/cache.db'
      );
    });
  });

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
