import { SQLiteTransactionCoordinator } from '../../src/database/storage/SQLiteTransactionCoordinator';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SQLiteTransactionCoordinator', () => {
  it('serializes concurrent top-level transactions', async () => {
    const coordinator = new SQLiteTransactionCoordinator();
    const firstGate = createDeferred<void>();
    const beginTransaction = jest.fn().mockResolvedValue(undefined);
    const commitTransaction = jest.fn().mockResolvedValue(undefined);
    const rollbackTransaction = jest.fn().mockResolvedValue(undefined);
    const order: string[] = [];

    const first = coordinator.run(
      async () => {
        order.push('begin');
        await beginTransaction();
      },
      async () => {
        order.push('commit');
        await commitTransaction();
      },
      rollbackTransaction,
      async () => {
        order.push('first-start');
        await firstGate.promise;
        order.push('first-end');
        return 'first';
      }
    );

    const second = coordinator.run(
      async () => {
        order.push('begin');
        await beginTransaction();
      },
      async () => {
        order.push('commit');
        await commitTransaction();
      },
      rollbackTransaction,
      async () => {
        order.push('second-start');
        return 'second';
      }
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['begin', 'first-start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');

    expect(order).toEqual([
      'begin',
      'first-start',
      'first-end',
      'commit',
      'begin',
      'second-start',
      'commit'
    ]);
    expect(beginTransaction).toHaveBeenCalledTimes(2);
    expect(commitTransaction).toHaveBeenCalledTimes(2);
    expect(rollbackTransaction).not.toHaveBeenCalled();
  });

  it('serializes a transaction that starts after the first body has entered', async () => {
    const coordinator = new SQLiteTransactionCoordinator();
    const firstGate = createDeferred<void>();
    const firstStarted = createDeferred<void>();
    const beginTransaction = jest.fn().mockResolvedValue(undefined);
    const commitTransaction = jest.fn().mockResolvedValue(undefined);
    const rollbackTransaction = jest.fn().mockResolvedValue(undefined);
    const order: string[] = [];

    const first = coordinator.run(
      async () => {
        order.push('first-begin');
        await beginTransaction();
      },
      async () => {
        order.push('first-commit');
        await commitTransaction();
      },
      rollbackTransaction,
      async () => {
        order.push('first-start');
        firstStarted.resolve();
        await firstGate.promise;
        order.push('first-end');
      }
    );

    await firstStarted.promise;

    const second = coordinator.run(
      async () => {
        order.push('second-begin');
        await beginTransaction();
      },
      async () => {
        order.push('second-commit');
        await commitTransaction();
      },
      rollbackTransaction,
      async () => {
        order.push('second-start');
      }
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['first-begin', 'first-start']);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'first-begin',
      'first-start',
      'first-end',
      'first-commit',
      'second-begin',
      'second-start',
      'second-commit'
    ]);
    expect(beginTransaction).toHaveBeenCalledTimes(2);
    expect(commitTransaction).toHaveBeenCalledTimes(2);
    expect(rollbackTransaction).not.toHaveBeenCalled();
  });

  it('rolls back when the transaction body throws', async () => {
    const coordinator = new SQLiteTransactionCoordinator();
    const beginTransaction = jest.fn().mockResolvedValue(undefined);
    const commitTransaction = jest.fn().mockResolvedValue(undefined);
    const rollbackTransaction = jest.fn().mockResolvedValue(undefined);

    await expect(
      coordinator.run(
        beginTransaction,
        commitTransaction,
        rollbackTransaction,
        async () => {
          throw new Error('boom');
        }
      )
    ).rejects.toThrow('boom');

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
