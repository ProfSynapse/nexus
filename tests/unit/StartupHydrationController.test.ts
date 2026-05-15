import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';

describe('StartupHydrationController', () => {
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
});
