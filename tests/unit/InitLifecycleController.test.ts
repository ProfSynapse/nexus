import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';

describe('InitLifecycleController', () => {
  it('resolves waitForReady=true on successful work', async () => {
    const c = new InitLifecycleController();
    void c.run(async () => undefined, { blocking: false });
    await expect(c.waitForReady()).resolves.toBe(true);
    expect(c.isReady()).toBe(true);
    expect(c.getError()).toBeNull();
  });

  it('resolves waitForReady=false on rejected work (no hang)', async () => {
    const c = new InitLifecycleController();
    void c.run(async () => { throw new Error('boom'); }, { blocking: false });
    const ok = await c.waitForReady();
    expect(ok).toBe(false);
    expect(c.isReady()).toBe(false);
    expect(c.isInitialized()).toBe(true);
    expect(c.getError()?.message).toBe('boom');
  });

  // The structural guarantee that fixes issue #209: even when the work
  // function rejects, the init promise must settle so every queued waiter
  // eventually resolves. The pre-extraction adapter had a code path where
  // a rejection set initError but never called initResolve, stranding every
  // waitForQueryReady() caller for the full 60s timeout.
  it('issue #209: synchronous throw in work still settles the init promise', async () => {
    const c = new InitLifecycleController();
    const startedAt = Date.now();
    void c.run(async () => {
      // Synchronous throw — pre-extraction would skip initResolve.
      throw new Error('sync throw');
    }, { blocking: false });
    const ok = await c.waitForReady();
    const elapsed = Date.now() - startedAt;
    expect(ok).toBe(false);
    // Must settle near-instantly, not at any per-caller timeout.
    expect(elapsed).toBeLessThan(50);
  });

  it('issue #209: non-Error rejection is wrapped before persisting', async () => {
    const c = new InitLifecycleController();
    void c.run(async () => { throw 'string-error'; }, { blocking: false });
    await c.waitForReady();
    expect(c.getError()?.message).toBe('string-error');
  });

  it('run is idempotent — second call returns same outcome without re-running', async () => {
    const c = new InitLifecycleController();
    const work = jest.fn(async () => undefined);
    void c.run(work, { blocking: false });
    void c.run(work, { blocking: false });
    await c.waitForReady();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('blocking=true throws the error inline', async () => {
    const c = new InitLifecycleController();
    await expect(
      c.run(async () => { throw new Error('blocking-boom'); }, { blocking: true })
    ).rejects.toThrow('blocking-boom');
    // And waitForReady still resolves false (no hang).
    await expect(c.waitForReady()).resolves.toBe(false);
  });

  it('hasStarted is false before run, true after', () => {
    const c = new InitLifecycleController();
    expect(c.hasStarted()).toBe(false);
    void c.run(async () => undefined, { blocking: false });
    expect(c.hasStarted()).toBe(true);
  });
});
