export class SQLiteTransactionCoordinator {
  private transactionLock: Promise<void> = Promise.resolve();

  async run<T>(
    beginTransaction: () => Promise<void>,
    commitTransaction: () => Promise<void>,
    rollbackTransaction: () => Promise<void>,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.exclusive(async () => {
      await beginTransaction();

      try {
        const result = await fn();
        await commitTransaction();
        return result;
      } catch (error) {
        await rollbackTransaction();
        throw error;
      }
    });
  }

  /**
   * Run `fn` with no transaction open and none able to start until it ends.
   * For statements SQLite refuses inside a transaction, such as VACUUM.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    let releaseLock: (() => void) | undefined;
    const previousLock = this.transactionLock;
    this.transactionLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    try {
      await previousLock;
      return await fn();
    } finally {
      releaseLock?.();
    }
  }
}
