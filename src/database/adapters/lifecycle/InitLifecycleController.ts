/**
 * Owns the initialization promise lifecycle for HybridStorageAdapter.
 *
 * Contract — the initPromise ALWAYS settles, whether the supplied work
 * function resolves, rejects, or throws synchronously. Prior to extraction,
 * the adapter had a code path where `performInitialization` could reject
 * after the catch-handler swallowed the error without ever calling
 * `initResolve`, stranding every `waitForReady`/`waitForQueryReady` caller
 * for the full 60s timeout. The contract here makes that bug structurally
 * impossible (issue #209).
 *
 * Usage:
 *
 *   controller.run(() => this.performInitialization(), { blocking: false });
 *   await controller.waitForReady();    // resolves on success or failure
 *   const err = controller.getError();  // null on success
 */
export class InitLifecycleController {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initError: Error | null = null;

  isReady(): boolean {
    return this.initialized && !this.initError;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getError(): Error | null {
    return this.initError;
  }

  hasStarted(): boolean {
    return this.initPromise !== null;
  }

  /**
   * Start the work function (idempotent — second call returns the same
   * promise without re-running the work). On `blocking: true`, awaits
   * completion and rethrows on failure; on `blocking: false`, returns
   * immediately and runs the work in the background.
   *
   * Whatever the work does, `initPromise` is guaranteed to settle and
   * `markInitialized` is called exactly once.
   */
  async run(work: () => Promise<void>, opts: { blocking?: boolean } = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      if (opts.blocking) {
        await this.initPromise;
        if (this.initError) throw this.initError;
      }
      return;
    }

    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    const settle = () => {
      this.initialized = true;
      const resolve = this.initResolve;
      this.initResolve = null;
      resolve?.();
    };

    // Fire the work; the .then/.catch handlers below GUARANTEE settle()
    // runs exactly once regardless of how work resolves.
    Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.initError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(settle);

    if (opts.blocking) {
      await this.initPromise;
      if (this.initError) throw this.initError;
    }
  }

  /**
   * Wait for initialization to complete. Returns true on success, false
   * on failure. Resolves immediately if init has already settled.
   */
  async waitForReady(): Promise<boolean> {
    if (this.initialized) {
      return !this.initError;
    }
    if (this.initPromise) {
      await this.initPromise;
    }
    return this.initialized && !this.initError;
  }

  /**
   * Mark init as failed externally (e.g. when a downstream observer
   * detects an unrecoverable error before `run` is called). Idempotent.
   */
  recordExternalError(error: Error): void {
    if (!this.initError) {
      this.initError = error;
    }
  }
}
