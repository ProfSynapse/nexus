export class SQLiteTransactionCoordinator {
  private transactionLock: Promise<void> = Promise.resolve();

  async run<T>(
    beginTransaction: () => Promise<void>,
    commitTransaction: () => Promise<void>,
    rollbackTransaction: () => Promise<void>,
    fn: () => Promise<T>
  ): Promise<T> {
    let releaseLock: (() => void) | undefined;
    const previousLock = this.transactionLock;
    this.transactionLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    try {
      await previousLock;
      await beginTransaction();

      try {
        const result = await fn();
        await commitTransaction();
        return result;
      } catch (error) {
        await rollbackTransaction();
        throw error;
      }
    } finally {
      releaseLock?.();
    }
  }
}
