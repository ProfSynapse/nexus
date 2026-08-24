import { ServiceContainer } from '../../src/core/ServiceContainer';

describe('ServiceContainer async cleanup', () => {
  it('awaits cleanup before clearing service state', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const container = new ServiceContainer();
    container.register('slow', () => ({ cleanup: jest.fn(async () => gate) }));
    await container.get('slow');

    let settled = false;
    const clearing = container.clear().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(container.isReady('slow')).toBe(true);
    release();
    await clearing;
    expect(container.isReady('slow')).toBe(false);
  });

  it('invalidates and cleans a service that finishes initializing during teardown', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const container = new ServiceContainer();
    container.register('pending', async () => {
      await gate;
      return { cleanup };
    });

    const initialization = container.get('pending');
    let clearSettled = false;
    const clearing = container.clear().then(() => { clearSettled = true; });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    release();

    await expect(initialization).rejects.toThrow(/cancelled during container teardown/);
    await clearing;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.isReady('pending')).toBe(false);
  });

  it('cleans initialized services before waiting on factories they unblock', async () => {
    let releasePending!: () => void;
    const pendingGate = new Promise<void>(resolve => { releasePending = resolve; });
    const existingCleanup = jest.fn(async () => { releasePending(); });
    const pendingCleanup = jest.fn().mockResolvedValue(undefined);
    const container = new ServiceContainer();
    container.register('existing', () => ({ cleanup: existingCleanup }));
    container.register('pending', async () => {
      await pendingGate;
      return { cleanup: pendingCleanup };
    });
    await container.get('existing');
    const initialization = container.get('pending');

    await container.clear();

    await expect(initialization).rejects.toThrow(/cancelled during container teardown/);
    expect(existingCleanup).toHaveBeenCalledTimes(1);
    expect(pendingCleanup).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent clear calls so each service is cleaned once', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = jest.fn(async () => gate);
    const container = new ServiceContainer();
    container.register('service', () => ({ cleanup }));
    await container.get('service');

    const first = container.clear();
    const second = container.clear();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
