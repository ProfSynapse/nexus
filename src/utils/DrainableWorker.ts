/**
 * A small, framework-free asynchronous worker with deterministic drain
 * semantics. It is intended for fire-and-forget producers whose callers still
 * need an explicit completion boundary for tests, teardown, or handoff.
 */

export type DrainableWorkerState = 'running' | 'paused' | 'closing' | 'closed';

export interface DrainableWorkerOptions<T> {
  concurrency?: number;
  onError?: (error: unknown, item: T) => void;
}

export interface DrainableWorker<T> {
  readonly state: DrainableWorkerState;
  enqueue(item: T): void;
  drain(): Promise<void>;
  pause(): void;
  resume(): void;
  close(options?: { cancelPending?: boolean }): Promise<void>;
}

class DrainableWorkerImpl<T> implements DrainableWorker<T> {
  private readonly queue: T[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private readonly concurrency: number;
  private activeCount = 0;
  private currentState: DrainableWorkerState = 'running';

  constructor(
    private readonly processor: (item: T) => Promise<void>,
    private readonly onError?: (error: unknown, item: T) => void,
    concurrency = 1
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('DrainableWorker concurrency must be a positive integer.');
    }

    this.concurrency = concurrency;
  }

  get state(): DrainableWorkerState {
    return this.currentState;
  }

  enqueue(item: T): void {
    if (this.currentState === 'closing' || this.currentState === 'closed') {
      throw new Error('Cannot enqueue work after DrainableWorker has started closing.');
    }

    this.queue.push(item);
    this.pump();
  }

  drain(): Promise<void> {
    if (this.isDrained()) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.drainWaiters.add(resolve);
    });
  }

  pause(): void {
    if (this.currentState === 'running') {
      this.currentState = 'paused';
    }
  }

  resume(): void {
    if (this.currentState !== 'paused') {
      return;
    }

    this.currentState = 'running';
    this.pump();
  }

  async close(options: { cancelPending?: boolean } = {}): Promise<void> {
    if (this.currentState === 'closed') {
      return;
    }

    if (this.currentState === 'closing') {
      await this.drain();
      return;
    }

    this.currentState = 'closing';
    if (options.cancelPending) {
      this.queue.length = 0;
    }

    this.pump();
    await this.drain();
    this.currentState = 'closed';
  }

  private pump(): void {
    if (this.currentState === 'paused' || this.currentState === 'closed') {
      return;
    }

    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift() as T;

      this.activeCount++;
      void Promise.resolve()
        .then(() => this.processor(item))
        .catch(error => {
          if (this.onError) {
            try {
              this.onError(error, item);
            } catch (handlerError) {
              console.error('[DrainableWorker] Error handler failed:', handlerError);
            }
          } else {
            console.error('[DrainableWorker] Work item failed:', error);
          }
        })
        .finally(() => {
          this.activeCount--;
          this.pump();
          this.resolveDrainWaitersIfIdle();
        });
    }

    this.resolveDrainWaitersIfIdle();
  }

  private isDrained(): boolean {
    return this.queue.length === 0 && this.activeCount === 0;
  }

  private resolveDrainWaitersIfIdle(): void {
    if (!this.isDrained()) {
      return;
    }

    const waiters = Array.from(this.drainWaiters);
    this.drainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export function createDrainableWorker<T>(
  processor: (item: T) => Promise<void>,
  options: DrainableWorkerOptions<T> = {}
): DrainableWorker<T> {
  return new DrainableWorkerImpl(
    processor,
    options.onError,
    options.concurrency ?? 1
  );
}
