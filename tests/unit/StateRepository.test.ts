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

/**
 * Issue #219: the archive flag is denormalized into the states table so
 * listing states never has to open the JSONL stream. These pin the write side
 * of that contract — the read side is in MemoryServiceGetStates.test.ts.
 */
describe('StateRepository archive-flag denormalization (v15)', () => {
  function insertCall(deps: RepositoryDependencies) {
    return (deps.sqliteCache.run as jest.Mock).mock.calls
      .find((call: unknown[]) => /INSERT INTO states/.test(call[0] as string));
  }

  it('writes isArchived from the snapshot content on save', async () => {
    const deps = createMockDeps();
    const repo = new StateRepository(deps);

    await repo.saveState('ws-1', 'session-1', {
      name: 'Archived checkpoint',
      content: { state: { metadata: { isArchived: true } } }
    });

    const call = insertCall(deps)!;
    expect(call[0]).toContain('isArchived');
    // columns: id, workspaceId, sessionId, name, description, created, tagsJson, isArchived
    expect((call[1] as unknown[])[7]).toBe(1);
  });

  it('writes 0 (not NULL) for a snapshot with no archive flag', async () => {
    const deps = createMockDeps();
    const repo = new StateRepository(deps);

    await repo.saveState('ws-1', 'session-1', {
      name: 'Live checkpoint',
      content: { state: { metadata: {} } }
    });

    expect((insertCall(deps)![1] as unknown[])[7]).toBe(0);
  });

  it('falls back to context.activeTask for the description column', async () => {
    // createState supplies no description at all; without this fallback the
    // metadata row cannot describe the state and listStates — which no longer
    // reads content — would report "No description" for every LLM-made state.
    const deps = createMockDeps();
    const repo = new StateRepository(deps);

    await repo.saveState('ws-1', 'session-1', {
      name: 'Checkpoint',
      content: { context: { activeTask: 'Wire up the backfill' } }
    });

    expect((insertCall(deps)![1] as unknown[])[4]).toBe('Wire up the backfill');
  });

  it('keeps an explicit description over the activeTask fallback', async () => {
    const deps = createMockDeps();
    const repo = new StateRepository(deps);

    await repo.saveState('ws-1', 'session-1', {
      name: 'Checkpoint',
      description: 'Explicit',
      content: { context: { activeTask: 'Wire up the backfill' } }
    });

    expect((insertCall(deps)![1] as unknown[])[4]).toBe('Explicit');
  });

  it('re-derives isArchived when a content update archives the state', async () => {
    // archiveState works by rewriting state.metadata.isArchived through
    // updateState, so this is the write that actually archives anything.
    const deps = createMockDeps();
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow());
    const repo = new StateRepository(deps);

    await repo.updateState('state-1', {
      content: { state: { metadata: { isArchived: true } } }
    });

    const update = (deps.sqliteCache.run as jest.Mock).mock.calls
      .find((call: unknown[]) => /UPDATE states SET/.test(call[0] as string))!;
    expect(update[0]).toContain('isArchived = ?');
    expect(update[1]).toContain(1);
  });

  it('filters archived rows in SQL only when includeArchived is explicitly false', async () => {
    const deps = createMockDeps();
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
    const repo = new StateRepository(deps);

    await repo.getStates('ws-1', undefined, { includeArchived: false });
    const filtered = (deps.sqliteCache.query as jest.Mock).mock.calls[0][0] as string;
    expect(filtered).toContain('isArchived IS NULL OR isArchived = 0');

    await repo.getStates('ws-1', undefined, { includeArchived: true });
    expect((deps.sqliteCache.query as jest.Mock).mock.calls[1][0] as string).not.toContain('isArchived');
  });

  it('returns archived rows when no archive option is passed', async () => {
    // Restoring an archived state, renaming one, and createState's
    // name-uniqueness check all call getStates with no options and must still
    // see archived rows. Filtering by default would break restore with
    // "State not found" and let a duplicate name through.
    const deps = createMockDeps();
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
    const repo = new StateRepository(deps);

    await repo.getStates('ws-1');

    expect((deps.sqliteCache.query as jest.Mock).mock.calls[0][0] as string).not.toContain('isArchived');
  });

  it('surfaces NULL isArchived as undefined, not false', async () => {
    // "unknown" must stay distinguishable from "not archived" or the read path
    // stops falling back to content for un-backfilled rows.
    const deps = createMockDeps();
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow({ isArchived: null }));
    const repo = new StateRepository(deps);

    const unknown = await repo.getById('state-1');
    expect(unknown?.isArchived).toBeUndefined();

    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow({ isArchived: 1 }));
    const archived = await repo.getById('state-1');
    expect(archived?.isArchived).toBe(true);

    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(stateMetadataRow({ isArchived: 0 }));
    const live = await repo.getById('state-1');
    expect(live?.isArchived).toBe(false);
  });
});

describe('StateRepository.backfillDerivedStateMetadata (v15 upgrade path)', () => {
  it('reads each workspace stream ONCE, not once per state', async () => {
    // Reading per state is precisely the quadratic cost issue #219 removes;
    // a backfill that reintroduced it would make the upgrade worse than the
    // problem.
    const events: AnyStateEvent[] = [
      savedEvent('state-1', { state: { metadata: { isArchived: true } } }),
      savedEvent('state-2', { context: { activeTask: 'Keep going' } }),
      updatedEvent('state-2', { state: { metadata: { isArchived: true } } }, 3)
    ];
    const deps = createMockDeps(events);
    (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
      { id: 'state-1', workspaceId: 'ws-1', description: null },
      { id: 'state-2', workspaceId: 'ws-1', description: null }
    ]);

    const repo = new StateRepository(deps);
    const updated = await repo.backfillDerivedStateMetadata();

    expect(updated).toBe(2);
    expect(deps.jsonlWriter.readEvents).toHaveBeenCalledTimes(1);
    expect(deps.jsonlWriter.readEvents).toHaveBeenCalledWith('workspaces/ws_ws-1.jsonl');

    const writes = (deps.sqliteCache.run as jest.Mock).mock.calls
      .filter((call: unknown[]) => /UPDATE states SET isArchived/.test(call[0] as string));
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toEqual([1, null, 'state-1']);
    // state-2 was archived by a later state_updated, and its description comes
    // from the saved snapshot's activeTask.
    expect(writes[1][1]).toEqual([1, null, 'state-2']);
  });

  it('does not touch JSONL when every row already knows its flag', async () => {
    const deps = createMockDeps();
    (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

    const repo = new StateRepository(deps);
    const updated = await repo.backfillDerivedStateMetadata();

    expect(updated).toBe(0);
    expect(deps.jsonlWriter.readEvents).not.toHaveBeenCalled();
    expect(deps.sqliteCache.run).not.toHaveBeenCalled();
  });

  it('leaves a row unknown when the stream has no event for it', async () => {
    const deps = createMockDeps([savedEvent('state-1', { value: 'x' })]);
    (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
      { id: 'state-missing', workspaceId: 'ws-1', description: null }
    ]);

    const repo = new StateRepository(deps);
    const updated = await repo.backfillDerivedStateMetadata();

    expect(updated).toBe(0);
    expect(deps.sqliteCache.run).not.toHaveBeenCalled();
  });
});
