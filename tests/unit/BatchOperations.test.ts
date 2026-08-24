import { BatchOperations } from '../../src/database/optimizations/BatchOperations';

describe('BatchOperations browser yielding', () => {
  it('uses MessageChannel between batches instead of a throttled timer', async () => {
    const original = globalThis.MessageChannel;
    let posts = 0;

    class TestMessageChannel {
      port1 = {
        onmessage: null as (() => void) | null,
        close: jest.fn(),
      };
      port2 = {
        postMessage: () => {
          posts += 1;
          queueMicrotask(() => this.port1.onmessage?.());
        },
        close: jest.fn(),
      };
    }

    Object.defineProperty(globalThis, 'MessageChannel', {
      configurable: true,
      value: TestMessageChannel,
    });

    try {
      const result = await BatchOperations.executeBatch(
        [1, 2, 3],
        async value => value * 2,
        { batchSize: 1, yieldBetweenBatches: true }
      );

      expect(result.results).toEqual([2, 4, 6]);
      expect(posts).toBe(2);
    } finally {
      Object.defineProperty(globalThis, 'MessageChannel', {
        configurable: true,
        value: original,
      });
    }
  });
});
