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
type TimeoutMode = 'total' | 'idle';

interface WaiterRecord {
  settle: Waiter;
  maxWaitMs: number;
  timeoutMode: TimeoutMode;
  onTimeout?: (maxWaitMs: number) => void;
  timer: number;
}

interface IdleWatchdog {
  idleTimeoutMs: number;
  onTimeout: () => void;
  timer: number;
}

/**
 * Encapsulates the startup-hydration phase machine and the query-ready
 * waiter queue for HybridStorageAdapter. Lifted out of the adapter so the
 * state machine has a single owner with a tight, testable API.
 *
 * Lifecycle: idle -> (running) -> complete | error.
 *
 * Waiters registered via `waitForQueryReady` resolve when the phase leaves
 * `running`/`error`, or when their timeout fires. Idle-mode waiters and the
 * rebuild watchdog reset on progress so large rebuilds are not failed solely
 * because their total duration exceeds a fixed wall-clock window.
 */
export class StartupHydrationController {
  private state: StartupHydrationState = { ...INITIAL_STATE };
  private waiters: WaiterRecord[] = [];
  private idleWatchdog: IdleWatchdog | null = null;

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
    this.armIdleWatchdog();
    this.armIdleWaiters();
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
    this.armIdleWatchdog();
    this.armIdleWaiters();
  }

  complete(): void {
    this.stopIdleWatchdog();
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
    this.stopIdleWatchdog();
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
    this.stopIdleWatchdog();
    this.state = { ...INITIAL_STATE };
    this.settleAll(true);
  }

  startIdleWatchdog(opts: {
    idleTimeoutMs: number;
    onTimeout: () => void;
  }): () => void {
    this.stopIdleWatchdog();
    this.idleWatchdog = {
      idleTimeoutMs: opts.idleTimeoutMs,
      onTimeout: opts.onTimeout,
      timer: 0
    };
    this.armIdleWatchdog();
    return () => this.stopIdleWatchdog();
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
    timeoutMode?: TimeoutMode;
    readyProbe?: () => boolean;
    onTimeout?: (maxWaitMs: number) => void;
  }): Promise<boolean> {
    if (opts.readyProbe && opts.readyProbe()) {
      return Promise.resolve(true);
    }

    if (this.state.phase !== 'running') {
      if (this.state.phase === 'error') {
        return Promise.resolve(false);
      }
      if (!opts.readyProbe) {
        return Promise.resolve(true);
      }
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter: WaiterRecord = {
        maxWaitMs: opts.maxWaitMs,
        timeoutMode: opts.timeoutMode ?? 'total',
        onTimeout: opts.onTimeout,
        timer: 0,
        settle: (value: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter(w => w !== waiter);
          resolve(value);
        }
      };
      this.waiters.push(waiter);
      this.armWaiter(waiter);
    });
  }

  /**
   * Resolve every queued waiter with `ready`. Internal - exposed for tests.
   */
  settleAll(ready: boolean): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      try { waiter.settle(ready); } catch { /* swallow - waiter already settled */ }
    }
  }

  private armIdleWatchdog(): void {
    if (!this.idleWatchdog) return;
    window.clearTimeout(this.idleWatchdog.timer);
    if (this.state.phase !== 'running') return;
    const watchdog = this.idleWatchdog;
    watchdog.timer = window.setTimeout(() => {
      if (this.idleWatchdog !== watchdog) return;
      this.idleWatchdog = null;
      watchdog.onTimeout();
    }, watchdog.idleTimeoutMs);
  }

  private stopIdleWatchdog(): void {
    if (!this.idleWatchdog) return;
    window.clearTimeout(this.idleWatchdog.timer);
    this.idleWatchdog = null;
  }

  private armWaiter(waiter: WaiterRecord): void {
    window.clearTimeout(waiter.timer);
    waiter.timer = window.setTimeout(() => {
      waiter.onTimeout?.(waiter.maxWaitMs);
      waiter.settle(false);
    }, waiter.maxWaitMs);
  }

  private armIdleWaiters(): void {
    for (const waiter of this.waiters) {
      if (waiter.timeoutMode === 'idle') {
        this.armWaiter(waiter);
      }
    }
  }
}
