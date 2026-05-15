import {
  ReconciliationCoordinator,
  type ReconcileCategory
} from '../../src/database/adapters/lifecycle/ReconciliationCoordinator';
import type { StorageEvent } from '../../src/database/interfaces/StorageEvents';

type FakeEvent = StorageEvent & { type: string; timestamp: number };

describe('ReconciliationCoordinator', () => {
  function makeDeps(initial: { files?: string[]; events?: Record<string, FakeEvent[]> } = {}) {
    const writer = {
      listFiles: jest.fn(async (_: string) => initial.files ?? []),
      readEvents: jest.fn(async <E>(path: string) => (initial.events?.[path] ?? []) as E[])
    };
    const cache = {
      save: jest.fn(async () => undefined)
    };
    return { writer: writer as never, cache: cache as never };
  }

  function makeCategory(overrides: Partial<ReconcileCategory<FakeEvent>> = {}): ReconcileCategory<FakeEvent> {
    return {
      label: 'thing',
      subdir: 'workspaces',
      filenameRegex: /workspaces\/ws_(.+)\.jsonl$/,
      existsInCache: async () => false,
      shouldSkipEvents: () => false,
      applyEvent: async () => undefined,
      ...overrides
    };
  }

  it('returns 0 and skips save() when there are no files', async () => {
    const { writer, cache } = makeDeps({ files: [] });
    const coord = new ReconciliationCoordinator(writer, cache);
    const result = await coord.reconcile(makeCategory());
    expect(result).toBe(0);
    expect(cache.save).not.toHaveBeenCalled();
  });

  it('skips files whose filename does not match the category regex', async () => {
    const { writer, cache } = makeDeps({
      files: ['workspaces/ws_a.jsonl', 'workspaces/garbage.txt'],
      events: { 'workspaces/ws_a.jsonl': [{ type: 'x', timestamp: 1 } as FakeEvent] }
    });
    const coord = new ReconciliationCoordinator(writer, cache);
    const apply = jest.fn().mockResolvedValue(undefined);
    const result = await coord.reconcile(makeCategory({ applyEvent: apply }));
    expect(result).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('skips files where the entity already exists in cache', async () => {
    const { writer, cache } = makeDeps({
      files: ['workspaces/ws_a.jsonl'],
      events: { 'workspaces/ws_a.jsonl': [{ type: 'x', timestamp: 1 } as FakeEvent] }
    });
    const coord = new ReconciliationCoordinator(writer, cache);
    const apply = jest.fn().mockResolvedValue(undefined);
    const result = await coord.reconcile(makeCategory({
      existsInCache: async () => true,
      applyEvent: apply
    }));
    expect(result).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(cache.save).not.toHaveBeenCalled();
  });

  it('applies events in timestamp order', async () => {
    const { writer, cache } = makeDeps({
      files: ['workspaces/ws_a.jsonl'],
      events: {
        'workspaces/ws_a.jsonl': [
          { type: 'late', timestamp: 30 } as FakeEvent,
          { type: 'first', timestamp: 10 } as FakeEvent,
          { type: 'middle', timestamp: 20 } as FakeEvent
        ]
      }
    });
    const apply = jest.fn().mockResolvedValue(undefined);
    const coord = new ReconciliationCoordinator(writer, cache);
    await coord.reconcile(makeCategory({ applyEvent: apply }));
    expect(apply.mock.calls.map((c) => (c[0] as FakeEvent).type))
      .toEqual(['first', 'middle', 'late']);
    expect(cache.save).toHaveBeenCalledTimes(1);
  });

  it('honors shouldSkipEvents short-circuit (e.g. delete-event present)', async () => {
    const { writer, cache } = makeDeps({
      files: ['workspaces/ws_a.jsonl'],
      events: { 'workspaces/ws_a.jsonl': [{ type: 'deleted', timestamp: 1 } as FakeEvent] }
    });
    const apply = jest.fn().mockResolvedValue(undefined);
    const coord = new ReconciliationCoordinator(writer, cache);
    const result = await coord.reconcile(makeCategory({
      shouldSkipEvents: (events) => events.some((e) => e.type === 'deleted'),
      applyEvent: apply
    }));
    expect(result).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('logs and continues when a single file throws — partial progress is preserved', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { writer, cache } = makeDeps({
        files: ['workspaces/ws_a.jsonl', 'workspaces/ws_b.jsonl'],
        events: {
          'workspaces/ws_a.jsonl': [{ type: 'x', timestamp: 1 } as FakeEvent],
          'workspaces/ws_b.jsonl': [{ type: 'y', timestamp: 1 } as FakeEvent]
        }
      });
      let firstCall = true;
      const apply = jest.fn().mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('apply failed for a');
        }
      });
      const coord = new ReconciliationCoordinator(writer, cache);
      const result = await coord.reconcile(makeCategory({ applyEvent: apply }));
      // ws_a failed mid-apply; ws_b succeeded.
      expect(result).toBe(1);
      expect(cache.save).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to reconcile thing a'),
        expect.any(Error)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips save() when nothing was reconciled', async () => {
    const { writer, cache } = makeDeps({
      files: ['workspaces/ws_a.jsonl'],
      events: { 'workspaces/ws_a.jsonl': [{ type: 'x', timestamp: 1 } as FakeEvent] }
    });
    const coord = new ReconciliationCoordinator(writer, cache);
    const result = await coord.reconcile(makeCategory({
      existsInCache: async () => true
    }));
    expect(result).toBe(0);
    expect(cache.save).not.toHaveBeenCalled();
  });
});
