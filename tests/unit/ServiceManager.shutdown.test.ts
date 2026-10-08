import type { App, Plugin } from 'obsidian';
import { ServiceManager, ServiceStage } from '../../src/core/ServiceManager';

describe('ServiceManager shutdown', () => {
  it('cleans lazily initialized services even when start was never called', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    const cleanup = jest.fn().mockResolvedValue(undefined);
    manager.registerLazy('remoteAgentJobs', () => ({ cleanup }));
    await manager.getService('remoteAgentJobs');
    await manager.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manager.getServiceIfReady('remoteAgentJobs')).toBeNull();
  });

  it('coalesces concurrent stops and waits for asynchronous cleanup', async () => {
    const manager = new ServiceManager({} as App, {} as Plugin);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = jest.fn(async () => gate);
    manager.registerLazy('remoteAgentJobs', () => ({ cleanup }));
    await manager.getService('remoteAgentJobs');
    let finished = false;
    const first = manager.stop().then(() => { finished = true; });
    const second = manager.stop();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cancels staged startup rather than creating background services after stop', async () => {
    jest.useFakeTimers();
    try {
      const manager = new ServiceManager({} as App, {} as Plugin);
      const create = jest.fn(() => ({}));
      manager.registerService({ name: 'background', stage: ServiceStage.BACKGROUND, create });
      await manager.start();
      await manager.stop();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(create).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
