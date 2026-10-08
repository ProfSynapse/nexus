import type { App, Plugin } from 'obsidian';
import { ServiceManager } from '../../src/core/ServiceManager';
import { PluginLifecycleManager, type PluginLifecycleConfig } from '../../src/core/PluginLifecycleManager';
import { ServiceRegistrar } from '../../src/core/services/ServiceRegistrar';

// Replace UI/registration dependencies only. Shutdown, the background processor,
// manager and dependency-ordered container are the production implementations.
jest.mock('../../src/core/services/ServiceRegistrar', () => ({ ServiceRegistrar: jest.fn(() => ({
  registerCoreServices: jest.fn(), initializeDataDirectories: jest.fn(),
  initializeBusinessServices: jest.fn(), preInitializeUICriticalServices: jest.fn(),
  initializeChatService: jest.fn(), shutdown: jest.fn()
})) }));
jest.mock('../../src/core/commands/MaintenanceCommandManager', () => ({ MaintenanceCommandManager: jest.fn() }));
jest.mock('../../src/core/commands/InlineEditCommandManager', () => ({ InlineEditCommandManager: jest.fn() }));
jest.mock('../../src/core/commands/ReadAloudCommandManager', () => ({ ReadAloudCommandManager: jest.fn() }));
jest.mock('../../src/core/ui/ChatUIManager', () => ({ ChatUIManager: jest.fn(() => ({ registerViewEarly: jest.fn() })) }));
jest.mock('../../src/core/ui/TaskBoardUIManager', () => ({ TaskBoardUIManager: jest.fn(() => ({ registerViewEarly: jest.fn() })) }));
jest.mock('../../src/core/settings/SettingsTabManager', () => ({ SettingsTabManager: jest.fn(() => ({ cleanup: jest.fn() })) }));
jest.mock('../../src/services/embeddings/EmbeddingManager', () => ({ EmbeddingManager: jest.fn() }));
jest.mock('../../src/core/ingest/VaultIngestionManager', () => ({ VaultIngestionManager: jest.fn() }));

function createLifecycle(manager: ServiceManager, loadSettings = jest.fn()) {
  return new PluginLifecycleManager({
    plugin: { getService: jest.fn() }, app: {}, serviceManager: manager,
    settings: { loadSettings }, manifest: {}
  } as unknown as PluginLifecycleConfig);
}

describe('PluginLifecycleManager shutdown', () => {
  it('awaits lazy remote service cleanup before closing storage and coalesces repeated unloads', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    const events: string[] = [];
    let release!: () => void;
    const pendingWrite = new Promise<void>(resolve => { release = resolve; });
    const close = jest.fn(async () => { events.push('storage:close'); });
    let jobsStopping: Promise<void> | undefined;
    const cleanupJobs = jest.fn(() => {
      if (jobsStopping) return jobsStopping;
      events.push('jobs:stop');
      jobsStopping = pendingWrite.then(() => { events.push('jobs:drained'); });
      return jobsStopping;
    });
    let registryStopped = false;
    const cleanupRegistry = jest.fn(() => {
      if (!registryStopped) events.push('registry:stop');
      registryStopped = true;
    });
    manager.registerLazy('hybridStorageAdapter', () => ({ close }));
    manager.registerLazy('remoteAgentRegistry', () => ({ cleanup: cleanupRegistry }));
    manager.registerFactory('remoteAgentJobs', () => ({ cleanup: cleanupJobs }), {
      dependencies: ['hybridStorageAdapter', 'remoteAgentRegistry']
    });
    await manager.getService('remoteAgentJobs');
    const lifecycle = createLifecycle(manager);

    const first = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(first);
    await Promise.resolve();
    expect(cleanupJobs).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    release();
    await first;

    expect(events).toEqual(['jobs:stop', 'registry:stop', 'jobs:drained', 'storage:close']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops remote timers synchronously before a slow embedding shutdown or failed state save', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    const cleanupJobs = jest.fn().mockResolvedValue(undefined);
    const cleanupRegistry = jest.fn();
    const close = jest.fn();
    const saveState = jest.fn().mockRejectedValue(new Error('state write failed'));
    manager.registerLazy('remoteAgentJobs', () => ({ cleanup: cleanupJobs }));
    manager.registerLazy('remoteAgentRegistry', () => ({ cleanup: cleanupRegistry }));
    manager.registerLazy('hybridStorageAdapter', () => ({ close }));
    manager.registerLazy('stateManager', () => ({ saveState }));
    await Promise.all(['remoteAgentJobs', 'remoteAgentRegistry', 'hybridStorageAdapter', 'stateManager']
      .map(name => manager.getService(name)));
    const lifecycle = createLifecycle(manager);
    let release!: () => void;
    const embeddingDrain = new Promise<void>(resolve => { release = resolve; });
    const embeddingShutdown = jest.fn(async () => embeddingDrain);
    (lifecycle as unknown as { embeddingManager: { shutdown(): Promise<void> } }).embeddingManager = {
      shutdown: embeddingShutdown
    };
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const unloading = lifecycle.shutdown();
      // No microtask yield: both timers are stopped before embedding work awaits.
      expect(cleanupJobs).toHaveBeenCalledTimes(1);
      expect(cleanupRegistry).toHaveBeenCalledTimes(1);
      expect(embeddingShutdown).toHaveBeenCalledTimes(1);
      expect(saveState).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      release();
      await unloading;
      expect(saveState).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(manager.getServiceIfReady('remoteAgentJobs')).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps storage open for lazy skill scans while remote work is already stopping', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    let releaseSkills!: () => void;
    let releaseRemote!: () => void;
    const skillScan = new Promise<void>(resolve => { releaseSkills = resolve; });
    const remoteWork = new Promise<void>(resolve => { releaseRemote = resolve; });
    const cleanupSkills = jest.fn(async () => skillScan);
    const cleanupJobs = jest.fn(async () => remoteWork);
    const close = jest.fn();
    manager.registerLazy('hybridStorageAdapter', () => ({ close, cleanup: close }));
    // SkillService resolves storage lazily and therefore lacks a container edge.
    manager.registerLazy('skillService', () => ({ cleanup: cleanupSkills }));
    manager.registerFactory('remoteAgentJobs', () => ({ cleanup: cleanupJobs }), {
      dependencies: ['hybridStorageAdapter']
    });
    await manager.getService('remoteAgentJobs');
    await manager.getService('skillService');
    const lifecycle = createLifecycle(manager);
    const unloading = lifecycle.shutdown();
    expect(cleanupJobs).toHaveBeenCalledTimes(1);
    expect(cleanupSkills).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    releaseRemote();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    releaseSkills();
    await unloading;
    expect(close).toHaveBeenCalled();
    expect(manager.getServiceIfReady('remoteAgentJobs')).toBeNull();
  });

  it('finishes remote and storage teardown when skill cleanup rejects', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    let releaseRemote!: () => void;
    const remoteWork = new Promise<void>(resolve => { releaseRemote = resolve; });
    const cleanupJobs = jest.fn(async () => remoteWork);
    const cleanupSkills = jest.fn().mockRejectedValue(new Error('scan cleanup failed'));
    const close = jest.fn();
    manager.registerLazy('hybridStorageAdapter', () => ({ close }));
    manager.registerLazy('skillService', () => ({ cleanup: cleanupSkills }));
    manager.registerFactory('remoteAgentJobs', () => ({ cleanup: cleanupJobs }), {
      dependencies: ['hybridStorageAdapter']
    });
    await manager.getService('remoteAgentJobs');
    await manager.getService('skillService');
    const lifecycle = createLifecycle(manager);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const unloading = lifecycle.shutdown();
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      releaseRemote();
      await unloading;
      expect(errorLog).toHaveBeenCalledWith(
        '[PluginLifecycleManager] Skill cleanup failed during shutdown:', expect.any(Error)
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(manager.getServiceIfReady('remoteAgentJobs')).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('fences background initialization already waiting on settings when unload begins', async () => {
    jest.useFakeTimers();
    try {
      const manager = new ServiceManager({} as App, {} as Plugin);
      let release!: () => void;
      const settingsRead = new Promise<void>(resolve => { release = resolve; });
      const loadSettings = jest.fn(async () => settingsRead);
      const lifecycle = createLifecycle(manager, loadSettings);
      await lifecycle.initialize();
      jest.advanceTimersByTime(0);
      expect(loadSettings).toHaveBeenCalledTimes(1);
      let finished = false;
      const unloading = lifecycle.shutdown().then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      release();
      await unloading;
      const registrar = (ServiceRegistrar as unknown as jest.Mock).mock.results.at(-1)?.value as {
        initializeDataDirectories: jest.Mock; initializeBusinessServices: jest.Mock
      };
      expect(registrar.initializeDataDirectories).not.toHaveBeenCalled();
      expect(registrar.initializeBusinessServices).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
