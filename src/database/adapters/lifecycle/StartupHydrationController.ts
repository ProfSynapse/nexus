import type { PluginScopedMigrationState, PluginScopedStorageState } from '../../migration/PluginScopedStorageCoordinator';

export interface StartupHydrationState {
  phase: 'idle' | 'running' | 'complete' | 'error';
  isBlocking: boolean;
  stage: string;
  progress: number;
  total: number;
  percent: number;
  statusText: string;
  error?: string;
}

export function shouldBlockStartupHydrationForVerifiedCutover(input: {
  migrationState: PluginScopedMigrationState;
  sourceOfTruthLocation: PluginScopedStorageState['sourceOfTruthLocation'];
  conversationFileCount: number;
  cachedConversationCount: number;
  cachedMessageCount: number;
}): boolean {
  return input.migrationState === 'verified'
    && input.sourceOfTruthLocation === 'vault-root'
    && input.conversationFileCount > 0
    && input.cachedConversationCount === 0
    && input.cachedMessageCount === 0;
}

const INITIAL_STATE: StartupHydrationState = {
  phase: 'idle',
  isBlocking: false,
  stage: '',
  progress: 0,
  total: 0,
  percent: 0,
  statusText: ''
};

type Waiter = (ready: boolean) => void;

/**
 * Encapsulates the startup-hydration phase machine and the query-ready
 * waiter queue for HybridStorageAdapter. Lifted out of the adapter so the
 * state machine has a single owner with a tight, testable API.
 *
 * Lifecycle: idle → (running) → complete | error.
 *
 * Waiters registered via `waitForQueryReady` resolve when the phase leaves
 * `running`/`error`, or when their per-call timeout fires. Each `start*`
 * variant settles outstanding waiters first if the new phase is itself
 * terminal (complete/error/idle), preserving the previous adapter behavior.
 */
export class StartupHydrationController {
  private state: StartupHydrationState = { ...INITIAL_STATE };
  private waiters: Waiter[] = [];

  getState(): StartupHydrationState {
    return { ...this.state };
  }

  isQueryReadyPhase(): boolean {
    return this.state.phase !== 'running' && this.state.phase !== 'error';
  }

  isBlocking(): boolean {
    return this.state.phase === 'running' && this.state.isBlocking;
  }

  startBlocking(): void {
    this.state = {
      phase: 'running',
      isBlocking: true,
      stage: 'Preparing cache rebuild',
      progress: 0,
      total: 1,
      percent: 0,
      statusText: 'Updating local chat index...'
    };
  }

  updateProgress(stage: string, progress: number, total: number, isBlocking: boolean): void {
    const safeTotal = total > 0 ? total : 1;
    const normalizedProgress = Math.max(0, Math.min(progress, safeTotal));
    this.state = {
      phase: 'running',
      isBlocking,
      stage,
      progress: normalizedProgress,
      total: safeTotal,
      percent: Math.round((normalizedProgress / safeTotal) * 100),
      statusText: stage === 'Complete'
        ? 'Local chat index updated'
        : `Updating local chat index: ${stage}`
    };
  }

  complete(): void {
    this.state = {
      phase: 'complete',
      isBlocking: false,
      stage: 'Complete',
      progress: 1,
      total: 1,
      percent: 100,
      statusText: 'Local chat index updated'
    };
    this.settleAll(true);
  }

  fail(error: string): void {
    this.state = {
      phase: 'error',
      isBlocking: false,
      stage: 'Error',
      progress: 0,
      total: 1,
      percent: 0,
      statusText: 'Local chat index update failed',
      error
    };
    this.settleAll(false);
  }

  clear(): void {
    this.state = { ...INITIAL_STATE };
    this.settleAll(true);
  }

  /**
   * Wait for the controller to leave the running/error phase. Resolves
   * `true` on a query-ready phase, `false` on timeout or terminal error.
   *
   * `readyProbe` is invoked at registration; if it returns true the
   * waiter resolves synchronously without ever queueing. This avoids a
   * race where the consumer is already query-ready when the waiter is
   * registered but the registration happens after the phase transition.
   */
  waitForReady(opts: {
    maxWaitMs: number;
    readyProbe?: () => boolean;
    onTimeout?: (maxWaitMs: number) => void;
  }): Promise<boolean> {
    if (opts.readyProbe && opts.readyProbe()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== settle);
        resolve(value);
      };
      const timer = window.setTimeout(() => {
        opts.onTimeout?.(opts.maxWaitMs);
        settle(false);
      }, opts.maxWaitMs);
      this.waiters.push(settle);
    });
  }

  /**
   * Resolve every queued waiter with `ready`. Internal — exposed for tests.
   */
  settleAll(ready: boolean): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      try { resolve(ready); } catch { /* swallow — waiter already settled */ }
    }
  }
}
