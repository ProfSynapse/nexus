import { StateRepository } from '../../src/database/repositories/StateRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import type {
  StateSavedEvent,
  StateUpdatedEvent
} from '../../src/database/interfaces/StorageEvents';

type AnyStateEvent = StateSavedEvent | StateUpdatedEvent;

function createMockDeps(events: AnyStateEvent[] = []): RepositoryDependencies {
  return {
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      run: jest.fn(),
      transaction: jest.fn((fn: () => Promise<unknown>) => fn())
    } as never,
    jsonlWriter: {
      appendEvent: jest.fn().mockImplementation((_path: string, ev: AnyStateEvent) => ({
        ...ev,
        id: 'evt-x',
        timestamp: Date.now(),
        deviceId: 'dev-1'
      })),
      readEvents: jest.fn().mockResolvedValue(events)
    } as never,
    queryCache: {
      cachedQuery: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    } as never
  };
}

function stateMetadataRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'state-1',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    name: 'Checkpoint',
    description: 'A checkpoint',
    created: 100,
    tagsJson: null,
    ...overrides
  };
}

function savedEvent(stateId: string, content: unknown, overrides: Partial<StateSavedEvent> = {}): StateSavedEvent {
  return {
    id: `evt-saved-${stateId}`,
    type: 'state_saved',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    timestamp: 1,
    deviceId: 'dev-1',
    data: {
      id: stateId,
      name: 'Checkpoint',
      description: 'A checkpoint',
      created: 100,
      stateJson: JSON.stringify(content),
      tags: undefined
    },
    ...overrides
  } as StateSavedEvent;
}

function updatedEvent(stateId: string, content: unknown, timestamp = 2, overrides: Partial<StateUpdatedEvent> = {}): StateUpdatedEvent {
  return {
    id: `evt-updated-${stateId}-${timestamp}`,
    type: 'state_updated',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    stateId,
    timestamp,
    deviceId: 'dev-1',
    data: {
      stateJson: JSON.stringify(content)
    },
    ...overrides
  } as StateUpdatedEvent;
}

describe('StateRepository.getStateData event-folding', () => {
  it('folds a single state_updated event over state_saved (returns updated content)', async () => {
    const events: AnyStateEvent[] = [
      savedEvent('state-1', { value: 'original' }),
      updatedEvent('state-1', { value: 'updated-once' }, 2)
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow());

    const repo = new StateRepository(deps);
    const result = await repo.getStateData('state-1');

    expect(result?.content).toEqual({ value: 'updated-once' });
    expect(deps.jsonlWriter.readEvents).toHaveBeenCalledWith('workspaces/ws_ws-1.jsonl');
  });

  it('returns the LATEST content when N×state_updated events are folded in order', async () => {
    const events: AnyStateEvent[] = [
      savedEvent('state-1', { value: 'original' }),
      updatedEvent('state-1', { value: 'second' }, 2),
      updatedEvent('state-1', { value: 'third' }, 3),
      updatedEvent('state-1', { value: 'latest' }, 4)
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow());

    const repo = new StateRepository(deps);
    const result = await repo.getStateData('state-1');

    expect(result?.content).toEqual({ value: 'latest' });
  });

  it('skips state_updated events targeting a different stateId in the same JSONL (cross-stateId isolation)', async () => {
    const events: AnyStateEvent[] = [
      savedEvent('state-1', { value: 'state1-original' }),
      // Updates for a SIBLING state in the same workspace JSONL must not bleed in
      updatedEvent('state-2', { value: 'state2-update' }, 2),
      updatedEvent('state-2', { value: 'state2-later-update' }, 3)
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow());

    const repo = new StateRepository(deps);
    const result = await repo.getStateData('state-1');

    expect(result?.content).toEqual({ value: 'state1-original' });
  });

  it('leaves content unchanged when a state_updated event has no stateJson (metadata-only update)', async () => {
    const metadataOnlyUpdate = updatedEvent('state-1', undefined, 2);
    // Remove stateJson to simulate metadata-only (name/description/tags only) update
    (metadataOnlyUpdate.data as { stateJson?: string }).stateJson = undefined;
    metadataOnlyUpdate.data.name = 'Renamed';

    const events: AnyStateEvent[] = [
      savedEvent('state-1', { value: 'original' }),
      metadataOnlyUpdate
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow());

    const repo = new StateRepository(deps);
    const result = await repo.getStateData('state-1');

    expect(result?.content).toEqual({ value: 'original' });
  });

  it('returns null via the metadata-not-found gate when the SQLite row is absent (delete tombstone)', async () => {
    // After state_deleted runs through WorkspaceEventApplier.applyStateDeleted, the
    // SQLite row is DELETEd. The next getStateData call hits the !metadata branch
    // and returns null BEFORE the fold loop is reached.
    const events: AnyStateEvent[] = [
      savedEvent('state-1', { value: 'original' }),
      updatedEvent('state-1', { value: 'updated' }, 2)
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

    const repo = new StateRepository(deps);
    const result = await repo.getStateData('state-1');

    expect(result).toBeNull();
    // Fold loop should never run when metadata is absent
    expect(deps.jsonlWriter.readEvents).not.toHaveBeenCalled();
  });
});
