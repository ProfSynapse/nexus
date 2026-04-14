jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  HybridStorageAdapter,
  shouldBlockStartupHydrationForVerifiedCutover
} from '../../src/database/adapters/HybridStorageAdapter';
import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

describe('HybridStorageAdapter', () => {
  describe('shouldBlockStartupHydrationForVerifiedCutover', () => {
    it('returns true for verified cutover when cache is empty but vault conversations exist', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'verified',
        sourceOfTruthLocation: 'vault-root',
        conversationFileCount: 12,
        cachedConversationCount: 0,
        cachedMessageCount: 0
      })).toBe(true);
    });

    it('returns false when the cache already has conversations', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'verified',
        sourceOfTruthLocation: 'vault-root',
        conversationFileCount: 12,
        cachedConversationCount: 4,
        cachedMessageCount: 20
      })).toBe(false);
    });

    it('returns false before verified cutover', () => {
      expect(shouldBlockStartupHydrationForVerifiedCutover({
        migrationState: 'pending',
        sourceOfTruthLocation: 'legacy-dotnexus',
        conversationFileCount: 12,
        cachedConversationCount: 0,
        cachedMessageCount: 0
      })).toBe(false);
    });
  });

  describe('applyStoragePlan', () => {
    it('wires the vault event store and read gating into JSONLWriter', () => {
      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        app: unknown;
        basePath: string;
        mobileLogPath?: string;
        vaultEventStore: unknown;
        jsonlWriter: {
          setBasePath: jest.Mock<void, [string]>;
          setReadBasePaths: jest.Mock<void, [string[]]>;
          setVaultEventStore: jest.Mock<void, [unknown]>;
          setVaultEventStoreReadEnabled: jest.Mock<void, [boolean]>;
        };
        sqliteCache: {
          setDbPath: jest.Mock<void, [string]>;
        };
      };

      adapter.app = { vault: { adapter: {} } };
      adapter.jsonlWriter = {
        setBasePath: jest.fn(),
        setReadBasePaths: jest.fn(),
        setVaultEventStore: jest.fn(),
        setVaultEventStoreReadEnabled: jest.fn()
      };
      adapter.sqliteCache = {
        setDbPath: jest.fn()
      };

      (adapter as any).applyStoragePlan({
        vaultWriteBasePath: 'Nexus/data',
        legacyReadBasePaths: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus'],
        pluginCacheDbPath: '.obsidian/plugins/claudesidian-mcp/data/cache.db',
        mobileLogPath: 'Nexus/data/_meta/mobile-sync-log.md',
        state: {
          storageVersion: 2,
          sourceOfTruthLocation: 'vault-root',
          migration: {
            state: 'verified',
            legacySourcesDetected: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus'],
            activeDestination: 'Nexus/data'
          }
        },
        roots: {} as never,
        vaultRoot: {
          configuredPath: 'Nexus',
          resolvedPath: 'Nexus',
          dataPath: 'Nexus/data',
          guidesPath: 'Nexus/guides',
          maxShardBytes: 1024
        }
      });

      expect(adapter.jsonlWriter.setBasePath).toHaveBeenCalledWith('Nexus/data');
      expect(adapter.jsonlWriter.setReadBasePaths).toHaveBeenCalledWith([
        '.obsidian/plugins/claudesidian-mcp/data',
        '.nexus'
      ]);
      expect(adapter.jsonlWriter.setVaultEventStore).toHaveBeenCalledWith(expect.any(Object));
      expect(adapter.jsonlWriter.setVaultEventStoreReadEnabled).toHaveBeenCalledWith(true);
      expect(adapter.sqliteCache.setDbPath).toHaveBeenCalledWith('.obsidian/plugins/claudesidian-mcp/data/cache.db');
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
