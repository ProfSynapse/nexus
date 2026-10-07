jest.mock('../../src/core/ServiceManager', () => ({}));
jest.mock('../../src/settings', () => ({}));
jest.mock('../../src/core/services/ServiceRegistrar', () => ({}));
jest.mock('../../src/core/commands/MaintenanceCommandManager', () => ({}));
jest.mock('../../src/core/commands/InlineEditCommandManager', () => ({}));
jest.mock('../../src/core/commands/ReadAloudCommandManager', () => ({}));
jest.mock('../../src/core/ui/ChatUIManager', () => ({}));
jest.mock('../../src/core/ui/TaskBoardUIManager', () => ({}));
jest.mock('../../src/core/background/BackgroundProcessor', () => ({}));
jest.mock('../../src/core/settings/SettingsTabManager', () => ({}));
jest.mock('../../src/core/ingest/VaultIngestionManager', () => ({}));
jest.mock('../../src/services/embeddings/EmbeddingManager', () => ({ EmbeddingManager: jest.fn() }));

import { PluginLifecycleManager } from '../../src/core/PluginLifecycleManager';
import { EmbeddingManager } from '../../src/services/embeddings/EmbeddingManager';
import type { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  // Exercise the lifecycle methods with explicit collaborators, avoiding UI
  // construction. The deferred work controls when teardown may close SQLite.
  const adapter = { close: jest.fn().mockResolvedValue(undefined) };
  const services = {
    getServiceIfReady: jest.fn((name: string) => name === 'hybridStorageAdapter' ? adapter : null),
    stop: jest.fn().mockResolvedValue(undefined)
  };
  const lifecycle = Object.create(PluginLifecycleManager.prototype) as PluginLifecycleManager;
  const internals = lifecycle as unknown as {
    config: unknown;
    pendingTimers: number[];
    serviceRegistrar: unknown;
    settingsTabManager: unknown;
    initializeEmbeddingsWhenReady(adapter: HybridStorageAdapter): Promise<void>;
    startBackgroundInitialization(): Promise<void>;
  };
  const loadSettings = jest.fn().mockResolvedValue(undefined);
  const registrar = {
    shutdown: jest.fn(), initializeDataDirectories: jest.fn().mockResolvedValue(undefined),
    initializeBusinessServices: jest.fn().mockResolvedValue(undefined)
  };
  internals.config = { serviceManager: services, settings: { loadSettings }, connector: { stop: jest.fn() } };
  internals.pendingTimers = [];
  internals.serviceRegistrar = registrar;
  internals.settingsTabManager = { cleanup: jest.fn() };
  return { lifecycle, internals, adapter, services, registrar, loadSettings };
}

describe('PluginLifecycleManager unload', () => {
  it('drains lazy-storage skill consumers before the container can clean the adapter', async () => {
    const { lifecycle, services, adapter } = harness();
    const scan = deferred();
    const skills = { cleanup: jest.fn(() => scan.promise) };
    services.getServiceIfReady.mockImplementation((name: string) => name === 'skillService' ? skills as unknown as typeof adapter : name === 'hybridStorageAdapter' ? adapter : null);
    const shutdown = lifecycle.shutdown();
    expect(skills.cleanup).toHaveBeenCalled(); expect(services.stop).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled();
    scan.resolve(); await shutdown;
    expect(services.stop).toHaveBeenCalled(); expect(adapter.close).toHaveBeenCalled();
  });

  it('keeps SQLite open until service cleanup has drained its active consumers', async () => {
    const { lifecycle, services, adapter } = harness();
    const cleanup = deferred(); services.stop.mockReturnValue(cleanup.promise);
    const shutdown = lifecycle.shutdown();
    await Promise.resolve();
    expect(services.stop).toHaveBeenCalled(); expect(adapter.close).not.toHaveBeenCalled();
    cleanup.resolve(); await shutdown;
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('does not create an embedding manager when storage readiness arrives after unload', async () => {
    const { lifecycle, internals } = harness();
    const ready = deferred();
    const adapter = { waitForQueryReady: () => ready.promise.then(() => true) } as unknown as HybridStorageAdapter;
    const initialization = internals.initializeEmbeddingsWhenReady(adapter);
    await lifecycle.shutdown(); ready.resolve(); await initialization;
    expect(EmbeddingManager).not.toHaveBeenCalled();
  });

  it('does not resume background startup after delayed settings finish on an unloaded plugin', async () => {
    const { lifecycle, internals, loadSettings, registrar } = harness();
    const settings = deferred(); loadSettings.mockReturnValue(settings.promise);
    const startup = internals.startBackgroundInitialization();
    await lifecycle.shutdown(); settings.resolve(); await startup;
    expect(registrar.initializeDataDirectories).not.toHaveBeenCalled();
    expect(registrar.initializeBusinessServices).not.toHaveBeenCalled();
  });
});
