import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import type { StateSavedEvent, StateUpdatedEvent } from '../../src/database/interfaces/StorageEvents';

type SqliteCacheLike = {
  run: jest.Mock<Promise<void>, [string, unknown[]]>;
};

/**
 * `rebuildCache()` throws the SQLite database away and replays JSONL through
 * this applier. Anything the applier does not write simply does not exist
 * afterwards — that is how the notes index tables were destroyed once already.
 *
 * So the archive flag denormalized in v15 (issue #219) has to survive a
 * rebuild, and it has to come out of the replay identical to what
 * StateRepository wrote on the live path. These tests fail against the
 * pre-fix applier, which wrote neither the column nor any content-derived
 * description.
 */
describe('WorkspaceEventApplier state archive flag (rebuild path)', () => {
  function makeApplier() {
    const sqliteCache = { run: jest.fn(async () => undefined) };
    return { sqliteCache, applier: new WorkspaceEventApplier(sqliteCache as SqliteCacheLike) };
  }

  function savedEvent(content: unknown, description?: string): StateSavedEvent {
    return {
      id: 'evt-1',
      type: 'state_saved',
      deviceId: 'device-1',
      timestamp: 1,
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      data: {
        id: 'state-1',
        name: 'Checkpoint',
        description,
        created: 100,
        stateJson: JSON.stringify(content)
      }
    } as StateSavedEvent;
  }

  it('replays an archived state as isArchived = 1', async () => {
    const { sqliteCache, applier } = makeApplier();

    await applier.apply(savedEvent({ state: { metadata: { isArchived: true } } }));

    const [sql, params] = sqliteCache.run.mock.calls[0];
    expect(sql).toContain('isArchived');
    expect(params[params.length - 1]).toBe(1);
  });

  it('replays a live state as isArchived = 0', async () => {
    const { sqliteCache, applier } = makeApplier();

    await applier.apply(savedEvent({ state: { metadata: {} } }));

    const [, params] = sqliteCache.run.mock.calls[0];
    expect(params[params.length - 1]).toBe(0);
  });

  it('leaves the flag NULL when the snapshot cannot be parsed', async () => {
    const { sqliteCache, applier } = makeApplier();
    const event = savedEvent({});
    (event.data as { stateJson: string }).stateJson = '{not json';

    await applier.apply(event);

    const [, params] = sqliteCache.run.mock.calls[0];
    expect(params[params.length - 1]).toBeNull();
  });

  it('derives the description from context.activeTask when the event carries none', async () => {
    const { sqliteCache, applier } = makeApplier();

    await applier.apply(savedEvent({ context: { activeTask: 'Replay me' } }));

    const [, params] = sqliteCache.run.mock.calls[0];
    // columns: id, sessionId, workspaceId, name, description, ...
    expect(params[4]).toBe('Replay me');
  });

  it('follows a state_updated that archives the state', async () => {
    // Archiving IS a content update. If the replay ignored it, every archived
    // state would come back visible after a cache rebuild.
    const { sqliteCache, applier } = makeApplier();

    const update: StateUpdatedEvent = {
      id: 'evt-2',
      type: 'state_updated',
      deviceId: 'device-1',
      timestamp: 2,
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      stateId: 'state-1',
      data: { stateJson: JSON.stringify({ state: { metadata: { isArchived: true } } }) }
    } as StateUpdatedEvent;

    await applier.apply(update);

    const [sql, params] = sqliteCache.run.mock.calls[0];
    expect(sql).toContain('UPDATE states SET');
    expect(sql).toContain('isArchived = ?');
    expect(params[0]).toBe(1);
  });

  it('ignores metadata-only updates for the archive flag', async () => {
    const { sqliteCache, applier } = makeApplier();

    await applier.apply({
      id: 'evt-3',
      type: 'state_updated',
      deviceId: 'device-1',
      timestamp: 3,
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      stateId: 'state-1',
      data: { name: 'Renamed' }
    } as StateUpdatedEvent);

    const [sql] = sqliteCache.run.mock.calls[0];
    expect(sql).toContain('name = ?');
    expect(sql).not.toContain('isArchived');
  });
});
