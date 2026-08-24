/**
 * DrainableWorker regression tests.
 *
 * These tests fail if drain observes only the pending queue, if errors strand
 * outstanding work, or if pause/close start work at the wrong time. Controlled
 * promises make the lifecycle observable without timer-based polling.
 */

import { createDrainableWorker } from '../../src/utils/DrainableWorker';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DrainableWorker', () => {
  it('drain waits for queued and active work', async () => {
    const first = deferred();
    const second = deferred();
    const secondStarted = deferred();
    const started: string[] = [];
    const completed: string[] = [];
    const gates = new Map([
      ['first', first],
      ['second', second],
    ]);
    const worker = createDrainableWorker<string>(async item => {
      started.push(item);
      if (item === 'second') {
        secondStarted.resolve();
      }
      await gates.get(item)?.promise;
      completed.push(item);
    });

    worker.enqueue('first');
    worker.enqueue('second');
    const drained = jest.fn();
    void worker.drain().then(drained);
    await flushMicrotasks();

    expect(started).toEqual(['first']);
    expect(drained).not.toHaveBeenCalled();

    first.resolve();
    await secondStarted.promise;
    expect(started).toEqual(['first', 'second']);
    expect(completed).toEqual(['first']);
    expect(drained).not.toHaveBeenCalled();

    second.resolve();
    await worker.drain();
    expect(completed).toEqual(['first', 'second']);
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('includes work enqueued while a drain is pending', async () => {
    const first = deferred();
    const second = deferred();
    const processed: string[] = [];
    const worker = createDrainableWorker<string>(async item => {
      await (item === 'first' ? first.promise : second.promise);
      processed.push(item);
    });

    worker.enqueue('first');
    const drainPromise = worker.drain();
    worker.enqueue('second');

    first.resolve();
    await flushMicrotasks();
    expect(processed).toEqual(['first']);

    second.resolve();
    await drainPromise;
    expect(processed).toEqual(['first', 'second']);
  });

  it('reports an error and still drains subsequent work', async () => {
    const errors: Array<{ error: unknown; item: string }> = [];
    const processed: string[] = [];
    const worker = createDrainableWorker<string>(
      async item => {
        if (item === 'broken') {
          throw new Error('boom');
        }
        processed.push(item);
      },
      {
        onError: (error, item) => errors.push({ error, item }),
      }
    );

    worker.enqueue('broken');
    worker.enqueue('healthy');
    await worker.drain();

    expect(errors).toHaveLength(1);
    expect(errors[0].item).toBe('broken');
    expect(errors[0].error).toEqual(new Error('boom'));
    expect(processed).toEqual(['healthy']);
  });

  it('pause blocks new starts while allowing active work to settle', async () => {
    const first = deferred();
    const started: string[] = [];
    const worker = createDrainableWorker<string>(async item => {
      started.push(item);
      if (item === 'first') {
        await first.promise;
      }
    });

    worker.enqueue('first');
    worker.enqueue('second');
    worker.pause();
    await flushMicrotasks();
    expect(worker.state).toBe('paused');
    expect(started).toEqual(['first']);

    first.resolve();
    await flushMicrotasks();
    expect(started).toEqual(['first']);

    worker.resume();
    await worker.drain();
    expect(started).toEqual(['first', 'second']);
    expect(worker.state).toBe('running');
  });

  it('close drains pending work and rejects future enqueues', async () => {
    const gate = deferred();
    const processed: string[] = [];
    const worker = createDrainableWorker<string>(async item => {
      if (item === 'first') {
        await gate.promise;
      }
      processed.push(item);
    });

    worker.enqueue('first');
    worker.enqueue('second');
    const closePromise = worker.close();
    expect(worker.state).toBe('closing');
    expect(() => worker.enqueue('late')).toThrow('started closing');

    gate.resolve();
    await closePromise;
    expect(processed).toEqual(['first', 'second']);
    expect(worker.state).toBe('closed');
  });

  it('close can cancel pending work without cancelling the active item', async () => {
    const gate = deferred();
    const processed: string[] = [];
    const worker = createDrainableWorker<string>(async item => {
      await gate.promise;
      processed.push(item);
    });

    worker.enqueue('active');
    worker.enqueue('pending');
    const closePromise = worker.close({ cancelPending: true });
    gate.resolve();
    await closePromise;

    expect(processed).toEqual(['active']);
    expect(worker.state).toBe('closed');
  });

  it('honors configured concurrency', async () => {
    const gate = deferred();
    const started: string[] = [];
    const worker = createDrainableWorker<string>(
      async item => {
        started.push(item);
        await gate.promise;
      },
      { concurrency: 2 }
    );

    worker.enqueue('one');
    worker.enqueue('two');
    worker.enqueue('three');
    await flushMicrotasks();
    expect(started).toEqual(['one', 'two']);

    gate.resolve();
    await worker.drain();
    expect(started).toEqual(['one', 'two', 'three']);
  });

  it('rejects invalid concurrency before accepting work', () => {
    expect(() => createDrainableWorker(async () => undefined, { concurrency: 0 }))
      .toThrow('positive integer');
    expect(() => createDrainableWorker(async () => undefined, { concurrency: 1.5 }))
      .toThrow('positive integer');
  });
});
