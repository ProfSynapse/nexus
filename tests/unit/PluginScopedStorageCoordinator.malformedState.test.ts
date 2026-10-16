/**
 * Regression tests for persisted `pluginStorage` records that are missing,
 * partial or malformed.
 *
 * Bug (5.21.1): a data.json whose `pluginStorage` existed but had no
 * `migration` object, e.g.
 *   "pluginStorage": { "storageVersion": 2, "sourceOfTruthLocation": "vault-root" }
 * made buildRuntimeState() throw on `persistedState.migration.state`. The
 * storage plan never resolved, so storage never became ready and every save
 * (workspaces, workflows, schedules) failed with "Storage is not ready".
 *
 * Expected: an unusable persisted record is treated exactly like an absent
 * one — the coordinator re-detects legacy data on disk and returns a fully
 * formed state (pending when legacy event data exists, not_needed otherwise).
 */

import { PluginScopedStorageCoordinator } from '../../src/database/migration/PluginScopedStorageCoordinator';
import { createMockApp } from '../helpers/mockVaultAdapter';

type PluginData = Record<string, unknown>;

function createCoordinator(
  initialData: unknown,
  initialFiles: Record<string, string> = {}
) {
  const { app, adapter } = createMockApp({ configDir: '.obsidian', initialFiles });
  let stored: unknown = initialData;
  const saveData = jest.fn(async (next: PluginData) => {
    stored = JSON.parse(JSON.stringify(next));
  });
  const loadData = jest.fn(async () => (stored === null || stored === undefined
    ? stored
    : JSON.parse(JSON.stringify(stored))));
  const coordinator = new PluginScopedStorageCoordinator(
    app as never,
    {
      manifest: {
        id: 'nexus',
        dir: '/mock/.obsidian/plugins/nexus'
      },
      loadData,
      saveData
    } as never,
    '.nexus'
  );
  return { coordinator, adapter, saveData, getStored: () => stored as PluginData };
}

const LEGACY_FILES = {
  '.nexus/workspaces/ws_alpha.jsonl': '{"id":"legacy-evt"}\n'
};

describe('PluginScopedStorageCoordinator — missing, partial or malformed pluginStorage', () => {
  it('initializes a not_needed state when pluginStorage is absent', async () => {
    const { coordinator, getStored } = createCoordinator({});

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('not_needed');
    expect(plan.state.sourceOfTruthLocation).toBe('vault-root');
    expect(plan.state.migration.activeDestination).toBe('Nexus/data');
    expect((getStored().pluginStorage as { migration: { state: string } }).migration.state).toBe('not_needed');
  });

  it('treats pluginStorage without a migration object as absent instead of throwing', async () => {
    const { coordinator, getStored } = createCoordinator({
      pluginStorage: { storageVersion: 2, sourceOfTruthLocation: 'vault-root' }
    });

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.storageVersion).toBe(2);
    expect(plan.state.sourceOfTruthLocation).toBe('vault-root');
    expect(plan.state.migration.state).toBe('not_needed');
    expect(plan.state.migration.legacySourcesDetected).toEqual([]);
    expect(plan.state.migration.activeDestination).toBe('Nexus/data');

    // The repaired, fully formed record is written back to data.json.
    const saved = getStored().pluginStorage as { migration: { state: string; activeDestination: string } };
    expect(saved.migration.state).toBe('not_needed');
    expect(saved.migration.activeDestination).toBe('Nexus/data');
  });

  it.each([
    ['null migration', { storageVersion: 2, sourceOfTruthLocation: 'vault-root', migration: null }],
    ['migration without a state', {
      storageVersion: 2,
      sourceOfTruthLocation: 'vault-root',
      migration: { legacySourcesDetected: [], activeDestination: 'Nexus/data' }
    }],
    ['migration with an unknown state', {
      storageVersion: 2,
      sourceOfTruthLocation: 'vault-root',
      migration: { state: 'bogus' }
    }],
    ['non-object migration', { storageVersion: 2, sourceOfTruthLocation: 'vault-root', migration: 'verified' }],
    ['non-object pluginStorage', 'vault-root'],
    ['null pluginStorage', null]
  ])('normalizes %s to a not_needed state when no legacy data exists', async (_label, pluginStorage) => {
    const { coordinator, getStored } = createCoordinator({ pluginStorage });

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('not_needed');
    expect(plan.state.sourceOfTruthLocation).toBe('vault-root');
    expect(plan.state.migration.activeDestination).toBe('Nexus/data');
    expect((getStored().pluginStorage as { migration: { state: string } }).migration.state).toBe('not_needed');
  });

  it('still migrates real legacy data when pluginStorage is partial', async () => {
    const { coordinator } = createCoordinator(
      { pluginStorage: { storageVersion: 2, sourceOfTruthLocation: 'vault-root' } },
      LEGACY_FILES
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('pending');
    expect(plan.state.sourceOfTruthLocation).toBe('legacy-dotnexus');
    expect(plan.state.migration.legacySourcesDetected).toEqual(['.nexus']);
    expect(plan.legacyReadBasePaths).toContain('.nexus');
    expect(typeof plan.state.migration.startedAt).toBe('number');

    // The rest of the migration lifecycle works against the repaired record.
    const verified = await coordinator.persistMigrationState(plan, 'verified', {
      completedAt: 10,
      verifiedAt: 20
    });
    expect(verified.migration.state).toBe('verified');
    expect(verified.sourceOfTruthLocation).toBe('vault-root');
    expect(verified.migration.startedAt).toBe(plan.state.migration.startedAt);
  });

  it('still migrates real legacy data when migration is null', async () => {
    const { coordinator } = createCoordinator(
      { pluginStorage: { storageVersion: 2, sourceOfTruthLocation: 'vault-root', migration: null } },
      LEGACY_FILES
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('pending');
    expect(plan.state.migration.legacySourcesDetected).toEqual(['.nexus']);
  });

  it('persists a migration outcome when data.json still holds a partial record', async () => {
    const { coordinator, getStored } = createCoordinator({}, LEGACY_FILES);
    const plan = await coordinator.prepareStoragePlan();

    // Simulate data.json being hand-edited back to a partial shape mid-session.
    getStored().pluginStorage = { storageVersion: 2, sourceOfTruthLocation: 'vault-root' };

    const failed = await coordinator.persistMigrationState(plan, 'failed', {
      completedAt: 30,
      lastError: 'boom'
    });
    expect(failed.migration.state).toBe('failed');
    expect(failed.migration.lastError).toBe('boom');
    expect(typeof failed.migration.startedAt).toBe('number');
  });

  it('writes a fully formed record when saving cache-backend state over a partial record', async () => {
    const { coordinator, getStored } = createCoordinator({
      pluginStorage: { storageVersion: 2, sourceOfTruthLocation: 'vault-root' }
    });

    await coordinator.writeCacheBackendState({ backend: 'idb', migrationState: 'verified', migratedAt: 1 });

    const saved = getStored().pluginStorage as {
      migration: { state: string };
      cacheBackend: { backend: string };
    };
    expect(saved.migration.state).toBe('not_needed');
    expect(saved.cacheBackend.backend).toBe('idb');
  });

  it('preserves cacheBackend from a partial record across the repair write', async () => {
    const { coordinator, getStored } = createCoordinator({
      pluginStorage: {
        storageVersion: 2,
        sourceOfTruthLocation: 'vault-root',
        cacheBackend: { backend: 'idb', migrationState: 'verified', migratedAt: 42 }
      }
    });

    await coordinator.prepareStoragePlan();

    const saved = getStored().pluginStorage as {
      migration: { state: string };
      cacheBackend: { migratedAt: number };
    };
    expect(saved.migration.state).toBe('not_needed');
    expect(saved.cacheBackend.migratedAt).toBe(42);
  });

  it('keeps the normal verified path unchanged', async () => {
    const { coordinator, adapter } = createCoordinator(
      {
        pluginStorage: {
          storageVersion: 2,
          sourceOfTruthLocation: 'vault-root',
          migration: {
            state: 'verified',
            startedAt: 111,
            completedAt: 222,
            verifiedAt: 333,
            legacySourcesDetected: ['.nexus'],
            activeDestination: 'Nexus/data'
          }
        }
      },
      {
        ...LEGACY_FILES,
        'Nexus/data/workspaces/ws_alpha.jsonl': '{"id":"legacy-evt"}\n'
      }
    );
    expect(await adapter.exists('Nexus/data/workspaces/ws_alpha.jsonl')).toBe(true);

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('verified');
    expect(plan.state.sourceOfTruthLocation).toBe('vault-root');
    expect(plan.state.migration.startedAt).toBe(111);
    expect(plan.state.migration.completedAt).toBe(222);
    expect(plan.state.migration.verifiedAt).toBe(333);
    expect(plan.state.migration.legacySourcesDetected).toEqual(['.nexus']);
    expect(plan.state.migration.activeDestination).toBe('Nexus/data');
  });
});
