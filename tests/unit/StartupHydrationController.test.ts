import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';

describe('StartupHydrationController', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts in idle (query-ready) phase', () => {
    const c = new StartupHydrationController();
    expect(c.getState().phase).toBe('idle');
    expect(c.isQueryReadyPhase()).toBe(true);
    expect(c.isBlocking()).toBe(false);
  });

  it('startBlocking transitions to running+blocking', () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const s = c.getState();
    expect(s.phase).toBe('running');
    expect(s.isBlocking).toBe(true);
    expect(c.isQueryReadyPhase()).toBe(false);
    expect(c.isBlocking()).toBe(true);
  });

  it('complete() settles queued waiters with true', async () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const p = c.waitForReady({ maxWaitMs: 5_000 });
    c.complete();
    await expect(p).resolves.toBe(true);
    expect(c.getState().phase).toBe('complete');
  });

  it('fail() settles queued waiters with false', async () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const p = c.waitForReady({ maxWaitMs: 5_000 });
    c.fail('disk dead');
    await expect(p).resolves.toBe(false);
    const s = c.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toBe('disk dead');
  });

  it('returns false immediately for waiters registered after terminal error', async () => {
    jest.useFakeTimers();
    const c = new StartupHydrationController();
    const onTimeout = jest.fn();
    c.fail('startup rebuild failed');

    const pending = c.waitForReady({ maxWaitMs: 5_000, timeoutMode: 'idle', onTimeout });
    await expect(pending).resolves.toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clear() settles queued waiters with true and returns to idle', async () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const p = c.waitForReady({ maxWaitMs: 5_000 });
    c.clear();
    await expect(p).resolves.toBe(true);
    expect(c.getState().phase).toBe('idle');
  });

  it('readyProbe short-circuits the timer (no hang on race)', async () => {
    const c = new StartupHydrationController();
    // Probe says we're already ready, even though phase is running.
    c.startBlocking();
    const startedAt = Date.now();
    const ok = await c.waitForReady({ maxWaitMs: 5_000, readyProbe: () => true });
    expect(ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('does not treat idle as ready when readyProbe says query state is not ready', async () => {
    jest.useFakeTimers();
    const c = new StartupHydrationController();
    const pending = c.waitForReady({ maxWaitMs: 50, readyProbe: () => false });
    let settled = false;
    void pending.then(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
  });

  it('timeout resolves false and invokes onTimeout once', async () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const onTimeout = jest.fn();
    const ok = await c.waitForReady({ maxWaitMs: 20, onTimeout });
    expect(ok).toBe(false);
    expect(onTimeout).toHaveBeenCalledWith(20);
  });

  it('settles all concurrent waiters at the same transition', async () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    const ps = [
      c.waitForReady({ maxWaitMs: 5_000 }),
      c.waitForReady({ maxWaitMs: 5_000 }),
      c.waitForReady({ maxWaitMs: 5_000 })
    ];
    c.complete();
    await expect(Promise.all(ps)).resolves.toEqual([true, true, true]);
  });

  it('updateProgress normalizes progress + total and clamps percent', () => {
    const c = new StartupHydrationController();
    c.startBlocking();
    c.updateProgress('Rebuilding', 150, 100, true);
    const s = c.getState();
    expect(s.progress).toBe(100); // clamped to total
    expect(s.total).toBe(100);
    expect(s.percent).toBe(100);
    expect(s.statusText).toBe('Updating local chat index: Rebuilding');

    c.updateProgress('Foo', -5, 0, false);
    const s2 = c.getState();
    expect(s2.progress).toBe(0); // clamped to 0
    expect(s2.total).toBe(1); // safeTotal fallback
  });

  it('idle-mode waiters reset their timeout when progress updates', async () => {
    jest.useFakeTimers();
    const c = new StartupHydrationController();
    c.startBlocking();
    const onTimeout = jest.fn();
    const pending = c.waitForReady({ maxWaitMs: 50, timeoutMode: 'idle', onTimeout });
    let settled = false;
    void pending.then(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(40);
    c.updateProgress('Processing workspaces', 1, 3, true);
    await jest.advanceTimersByTimeAsync(40);
    expect(settled).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe(false);
    expect(onTimeout).toHaveBeenCalledWith(50);
  });

  it('idle watchdog fails only after a no-progress interval', async () => {
    jest.useFakeTimers();
    const c = new StartupHydrationController();
    c.startBlocking();
    c.startIdleWatchdog({
      idleTimeoutMs: 50,
      onTimeout: () => c.fail('no progress')
    });

    await jest.advanceTimersByTimeAsync(40);
    c.updateProgress('Processing conversations', 1, 3, true);
    await jest.advanceTimersByTimeAsync(40);
    expect(c.getState().phase).toBe('running');

    await jest.advanceTimersByTimeAsync(10);
    const state = c.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toBe('no progress');
  });
});
