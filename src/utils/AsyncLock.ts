/**
 * Simple async lock to prevent race conditions in file operations
 */
export class AsyncLock {
  private promise: Promise<void>;

  constructor() {
    this.promise = Promise.resolve();
  }

  /**
   * Acquire the lock and run the task
   * @param task Async function to execute
   */
  async acquire<T>(task: () => Promise<T>): Promise<T> {
    // Chain the new task to the existing promise
    const result = this.promise.then(() => task());
    
    // Update the promise to wait for this task (handling errors)
    this.promise = result.then(() => {}, () => {});
    
    return result;
  }
}

/**
 * Map of locks for specific resources (e.g. file paths)
 */
export class NamedLocks {
  private locks: Map<string, AsyncLock> = new Map();

  /**
   * Acquire a lock for a specific name/path
   */
  async acquire<T>(name: string, task: () => Promise<T>): Promise<T> {
    if (!this.locks.has(name)) {
      this.locks.set(name, new AsyncLock());
    }
    return this.locks.get(name)!.acquire(task);
  }
}
