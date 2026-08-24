/**
 * Regression tests for permanent session deletion.
 *
 * Before the fix, `deleteSession` ran a single
 * `DELETE FROM sessions WHERE id = ?` and wrote NO event at all — the
 * `session_deleted` type did not exist (`grep -rn "session_deleted" src/`
 * returned nothing). Measured in a real vault (Obsidian 1.13.7, headless),
 * deleting a session holding 2 states / 2 traces / 1 trace embedding left:
 *
 *   after delete : sessions 0, states 2, memory_traces 2, trace_embedding_metadata 1
 *   after rebuild: sessions 1, states 2, memory_traces 2
 *
 * i.e. the session itself came BACK, because the workspace stream still held
 * `session_created` and replay had no tombstone to cancel it with. Every test
 * here fails against that code.
 */

import { SessionRepository } from '../../src/database/repositories/SessionRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { SyncCoordinator, type ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { purgeSessionRows } from '../../src/database/sessionOwnership';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import { createMockApp } from '../helpers/mockVaultAdapter';

const WS = 'ws-owner';
const SESSION = 'sess-target';
const BYSTANDER = 'sess-bystander';

/**
 * Records every statement so a test can ask "what did the cache actually see?",
 * and answers the one read the delete makes (the session's workspaceId).
 */
function createRecordingSqlite() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const cache = {
    run: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return undefined;
    }),
    query: jest.fn(async () => []),
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM sessions/i.test(sql)) {
        return { id: params[0], workspaceId: WS, name: 'S', startTime: 1, isActive: 1 };
      }
      return null;
    }),
    transaction: jest.fn((fn: () => Promise<unknown>) => fn()),
    getSyncState: jest.fn(async () => null),
    updateSyncState: jest.fn(async () => undefined),
    isEventApplied: jest.fn(async () => false),
    markEventApplied: jest.fn(async () => undefined),
    clearAllData: jest.fn(async () => undefined),
    rebuildFTSIndexes: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined)
  };
  const tablesTouchedBy = (verb: string): string[] =>
    statements
      .filter(s => s.sql.trim().toUpperCase().startsWith(verb))
      .map(s => {
        const m = s.sql.match(/(?:DELETE FROM|INSERT (?:OR (?:REPLACE|IGNORE) )?INTO|UPDATE)\s+([a-zA-Z_]+)/i);
        return m ? m[1] : s.sql;
      });
  return { cache, statements, tablesTouchedBy };
}

function build() {
  const { app } = createMockApp({ withLocalStorage: true });
  const vaultEventStore = new VaultEventStore({
    app,
    resolution: { resolvedPath: 'Nexus', dataPath: 'Nexus/data', maxShardBytes: 4096 }
  });
  const jsonlWriter = new JSONLWriter({
    app,
    basePath: '.obsidian/plugins/nexus/data',
    readBasePaths: ['.obsidian/plugins/nexus/data'],
    vaultEventStore
  });
  const { cache, statements, tablesTouchedBy } = createRecordingSqlite();
  const deps: RepositoryDependencies = {
    sqliteCache: cache as never,
    jsonlWriter,
    queryCache: new QueryCache()
  };
  return { app, vaultEventStore, jsonlWriter, cache, statements, tablesTouchedBy, deps };
}

/**
 * A `tool_operation_started` event, as `ToolOperationRepository.start` writes it
 * — into `workspaces/ws_<id>.jsonl`, the SAME stream the session's own events
 * live in.
 */
function receiptStarted(operationId: string, sessionId: string) {
  return {
    type: 'tool_operation_started',
    workspaceId: WS,
    data: {
      operationId,
      signature: `sig-${operationId}`,
      origin: 'native-chat',
      workspaceId: WS,
      sessionId,
      replayPolicy: 'never',
      replayable: false,
      commandSummary: 'content write --path a.md'
    }
  };
}

/** The events a real workspace stream carries for a session with children. */
async function seedWorkspaceStream(jsonlWriter: JSONLWriter) {
  await jsonlWriter.appendEvents(`workspaces/ws_${WS}.jsonl`, [
    { type: 'workspace_created', data: { id: WS, name: 'Owner', rootFolder: '/', created: 1 } },
    { type: 'session_created', workspaceId: WS, data: { id: SESSION, name: 'S1', startTime: 2 } },
    { type: 'session_created', workspaceId: WS, data: { id: BYSTANDER, name: 'S2', startTime: 3 } },
    { type: 'state_saved', workspaceId: WS, sessionId: SESSION, data: { id: 'st-1', name: 'St1', created: 4, stateJson: '{}' } },
    { type: 'state_saved', workspaceId: WS, sessionId: SESSION, data: { id: 'st-2', name: 'St2', created: 5, stateJson: '{}' } },
    { type: 'trace_added', workspaceId: WS, sessionId: SESSION, data: { id: 'tr-1', content: 'trace', traceType: 'note' } },
    { type: 'state_saved', workspaceId: WS, sessionId: BYSTANDER, data: { id: 'st-3', name: 'St3', created: 6, stateJson: '{}' } },
    receiptStarted('op-target', SESSION),
    receiptStarted('op-bystander', BYSTANDER)
  ] as never);
}

/**
 * Every table `SCHEMA_SQL` declares, with the `sessionId` column declaration if
 * it has one. Parsed rather than hand-listed so a table added later cannot slip
 * past the completeness test below.
 */
function sessionKeyedTables(): Array<{ table: string; notNull: boolean }> {
  const found: Array<{ table: string; notNull: boolean }> = [];
  const createTable = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)([^;]*);/gi;
  for (const match of SCHEMA_SQL.matchAll(createTable)) {
    const [, table, body] = match;
    for (const line of body.split('\n')) {
      if (line.includes('FOREIGN KEY')) continue;
      const column = line.trim().match(/^sessionId\s+TEXT(\s+NOT\s+NULL)?/i);
      if (column) {
        found.push({ table, notNull: Boolean(column[1]) });
        break;
      }
    }
  }
  return found;
}

/**
 * The purge list has to be complete against the schema, and "complete" has a
 * mechanical definition here: a NOT NULL `sessionId` means the row cannot exist
 * without the session, so the session owns it and deleting the session must
 * delete it. A nullable `sessionId` is a back-reference to an entity that
 * outlives the session, and purging it would destroy data nobody asked to
 * delete.
 *
 * This is the check that would have caught `tool_operation_receipts`: it arrived
 * with schema 15, after this branch was cut, and merged in with no textual
 * conflict at all.
 */
describe('the session purge list is complete against SCHEMA_SQL', () => {
  /**
   * Nullable `sessionId`, deliberately NOT purged as ownership. Each entry
   * carries the reason it is excluded, so adding one is a decision rather than
   * an omission.
   */
  const DELIBERATE_EXCLUSIONS: Record<string, string> = {
    conversations:
      'first-class entity with its own event stream; sessionId is a nullable ' +
      'back-reference and the conversation outlives the session',
    conversation_embedding_metadata:
      'keyed to conversations, which are excluded above, and embeddings are not ' +
      'replayable from JSONL'
  };

  /**
   * Nullable `sessionId`, but purged anyway — the rows are derived from
   * `memory_traces`, which the session does own, so leaving them would strand
   * embeddings pointing at traces that no longer exist.
   */
  const PURGED_DESPITE_NULLABLE = ['trace_embedding_metadata'];

  function tablesPurgedBySession(): Promise<string[]> {
    const touched: string[] = [];
    const sqlite = {
      run: async (sql: string) => {
        const match = sql.match(/DELETE FROM\s+(\w+)/i);
        if (match) touched.push(match[1]);
      },
      query: async () => []
    };
    return purgeSessionRows(sqlite, SESSION).then(() => touched);
  }

  it('purges every table whose sessionId is NOT NULL', async () => {
    const owned = sessionKeyedTables()
      .filter(t => t.notNull)
      .map(t => t.table);
    const purged = await tablesPurgedBySession();

    // Not an empty-set tautology: if the parse ever stops finding tables this
    // test would pass vacuously.
    expect(owned.length).toBeGreaterThanOrEqual(3);
    expect(owned).toEqual(
      expect.arrayContaining(['states', 'memory_traces', 'tool_operation_receipts'])
    );
    for (const table of owned) {
      expect(purged).toContain(table);
    }
  });

  it('purges nothing whose sessionId is nullable except the documented cases', async () => {
    const nullable = sessionKeyedTables()
      .filter(t => !t.notNull)
      .map(t => t.table);
    const purged = await tablesPurgedBySession();

    expect(nullable.length).toBeGreaterThan(0);
    for (const table of nullable) {
      if (PURGED_DESPITE_NULLABLE.includes(table)) {
        expect(purged).toContain(table);
        continue;
      }
      // A nullable sessionId that is neither purged nor documented means
      // somebody added a table and nobody decided what a delete should do
      // with it.
      expect(Object.keys(DELIBERATE_EXCLUSIONS)).toContain(table);
      expect(purged).not.toContain(table);
    }
  });

  it('purges the sessions row itself, last', async () => {
    const purged = await tablesPurgedBySession();
    expect(purged[purged.length - 1]).toBe('sessions');
  });
});

describe('permanent session delete removes everything the session owns', () => {
  // ==========================================================================
  // The replay half. This is what decides the outcome of `rebuildCache()`.
  // ==========================================================================
  describe('WorkspaceEventApplier: replaying session_deleted', () => {
    const tombstone = {
      id: 'evt-del',
      type: 'session_deleted',
      deviceId: 'dev',
      timestamp: 10,
      workspaceId: WS,
      sessionId: SESSION
    };

    it('purges every session-keyed table, not just the sessions row', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      // Pre-fix this array was empty: the applier had no case for the event
      // type at all, and the switch has no default branch.
      expect(tablesTouchedBy('DELETE')).toEqual(
        expect.arrayContaining([
          'trace_embedding_metadata',
          'states',
          'memory_traces',
          'tool_operation_receipts',
          'sessions'
        ])
      );
    });

    /**
     * `tool_operation_receipts` (schema 15) landed after this branch was cut and
     * merged into it without a single textual conflict, which is exactly how a
     * purge list goes stale. Its `sessionId` is TEXT NOT NULL, so a session owns
     * its receipts by the same rule that makes it own its states and traces —
     * and its events are appended to the same workspace stream, so replay
     * re-creates them right before it reaches the tombstone.
     */
    it('purges the tool operation receipts the session owns', async () => {
      const { cache, statements } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const receiptPurge = statements.find(s =>
        /DELETE FROM tool_operation_receipts/i.test(s.sql)
      );
      expect(receiptPurge).toBeDefined();
      expect(receiptPurge?.sql).toMatch(/WHERE\s+sessionId\s*=\s*\?/i);
      expect(receiptPurge?.params).toEqual([SESSION]);
    });

    it('deletes the sessions row last, so nothing is orphaned mid-purge', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const deleted = tablesTouchedBy('DELETE');
      expect(deleted.indexOf('sessions')).toBe(deleted.length - 1);
      expect(deleted.indexOf('states')).toBeLessThan(deleted.indexOf('sessions'));
      expect(deleted.indexOf('memory_traces')).toBeLessThan(deleted.indexOf('sessions'));
      expect(deleted.indexOf('tool_operation_receipts')).toBeLessThan(deleted.indexOf('sessions'));
    });

    it('scopes every statement to the session, never to the workspace', async () => {
      const { cache, statements } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const deletes = statements.filter(s => /^\s*DELETE/i.test(s.sql));
      expect(deletes.length).toBeGreaterThan(0);
      for (const statement of deletes) {
        expect(statement.params).not.toContain(WS);
      }
    });

    it('leaves conversations alone — they outlive the session by design', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      expect(tablesTouchedBy('DELETE')).not.toContain('conversations');
      expect(tablesTouchedBy('DELETE')).not.toContain('messages');
    });

    it('ignores a tombstone with no sessionId rather than purging everything', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply({ ...tombstone, sessionId: '' } as never);

      expect(tablesTouchedBy('DELETE')).toEqual([]);
    });
  });

  // ==========================================================================
  // The live delete, wired to a real event store over a real (mock) vault.
  // ==========================================================================
  describe('SessionRepository.delete over a real event store', () => {
    it('writes a session_deleted tombstone into the parent workspace stream', async () => {
      const { jsonlWriter, vaultEventStore, deps } = build();
      await seedWorkspaceStream(jsonlWriter);

      await new SessionRepository(deps).delete(SESSION);

      const events = await vaultEventStore.readEvents<{ type: string; sessionId?: string }>(
        `workspaces/ws_${WS}.jsonl`
      );
      // Pre-fix: no event of any kind was written by a session delete.
      expect(events.filter(e => e.type === 'session_deleted')).toEqual([
        expect.objectContaining({ type: 'session_deleted', sessionId: SESSION, workspaceId: WS })
      ]);
    });

    it('never removes the workspace stream — it is shared with the workspace and its siblings', async () => {
      const { jsonlWriter, vaultEventStore, deps } = build();
      await seedWorkspaceStream(jsonlWriter);

      await new SessionRepository(deps).delete(SESSION);

      expect(await vaultEventStore.listFiles('workspaces')).toContain(`workspaces/ws_${WS}.jsonl`);
      const events = await vaultEventStore.readEvents<{ type: string; data?: { id?: string } }>(
        `workspaces/ws_${WS}.jsonl`
      );
      expect(events.some(e => e.type === 'workspace_created')).toBe(true);
      expect(
        events.some(e => e.type === 'session_created' && e.data?.id === BYSTANDER)
      ).toBe(true);
    });

    it('purges the session-keyed SQLite tables, not just the sessions row', async () => {
      const { jsonlWriter, deps, tablesTouchedBy } = build();
      await seedWorkspaceStream(jsonlWriter);

      await new SessionRepository(deps).delete(SESSION);

      // Pre-fix this array was exactly ['sessions'].
      expect(tablesTouchedBy('DELETE')).toEqual(
        expect.arrayContaining([
          'states',
          'memory_traces',
          'tool_operation_receipts',
          'sessions'
        ])
      );
    });

    it('writes the tombstone before it touches the cache', async () => {
      const { jsonlWriter, deps, cache } = build();
      await seedWorkspaceStream(jsonlWriter);
      const appendSpy = jest.spyOn(jsonlWriter, 'appendEvent');

      await new SessionRepository(deps).delete(SESSION);

      expect(appendSpy.mock.invocationCallOrder[0]).toBeLessThan(
        cache.run.mock.invocationCallOrder[0]
      );
    });

    describe('partial failure', () => {
      it('does not touch SQLite when the tombstone cannot be written, so the delete stays retryable', async () => {
        const { jsonlWriter, deps, tablesTouchedBy } = build();
        await seedWorkspaceStream(jsonlWriter);
        jest.spyOn(jsonlWriter, 'appendEvent').mockRejectedValue(new Error('vault is locked'));

        await expect(new SessionRepository(deps).delete(SESSION)).rejects.toThrow('vault is locked');

        // Pre-fix the sessions row was deleted regardless — a session that
        // stopped listing and came straight back on the next rebuild.
        expect(tablesTouchedBy('DELETE')).toEqual([]);
      });

      it('refuses to delete a session that does not exist rather than writing a stray tombstone', async () => {
        const { jsonlWriter, vaultEventStore, deps } = build();
        await seedWorkspaceStream(jsonlWriter);
        const repo = new SessionRepository(deps);
        jest.spyOn(repo, 'getById').mockResolvedValue(null);

        await expect(repo.delete('ghost')).rejects.toThrow(/not found/i);

        const events = await vaultEventStore.readEvents<{ type: string }>(
          `workspaces/ws_${WS}.jsonl`
        );
        expect(events.some(e => e.type === 'session_deleted')).toBe(false);
      });
    });
  });

  // ==========================================================================
  // The rebuild path — the only test that proves the delete is real.
  // ==========================================================================
  describe('rebuildCache() after a delete', () => {
    /**
     * A session has no stream of its own, so replay legitimately re-inserts the
     * session, its states and its traces before reaching the tombstone. What has
     * to be true is that the tombstone comes after and cancels them — the net
     * effect being an empty session. Row-level proof needs a real SQLite (the
     * wasm is mocked in Jest); it is in the live rig. Here we pin the ordering
     * property that produces it.
     */
    it('ends the replay of the session with a purge, not an insert', async () => {
      const { jsonlWriter, deps, cache, statements } = build();
      await seedWorkspaceStream(jsonlWriter);

      await new SessionRepository(deps).delete(SESSION);

      // Everything up to here is setup; the rebuild is the assertion.
      statements.length = 0;
      const coordinator = new SyncCoordinator(
        jsonlWriter as never,
        cache as unknown as ISQLiteCacheManager
      );
      const result = await coordinator.fullRebuild();

      expect(result.success).toBe(true);

      const touchingSession = statements.filter(s =>
        JSON.stringify(s.params).includes(SESSION)
      );
      const purges = touchingSession.filter(s => /^\s*DELETE/i.test(s.sql));
      // Pre-fix this was zero: the stream still held session_created,
      // state_saved and trace_added, and nothing in the replay removed them —
      // the measured `sessions 0 → 1` across a rebuild.
      expect(purges.length).toBeGreaterThan(0);

      const lastTouch = touchingSession[touchingSession.length - 1];
      expect(lastTouch.sql).toMatch(/DELETE FROM sessions/i);

      // Every insert for this session is undone by a later purge.
      const lastInsert = touchingSession
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => /^\s*INSERT/i.test(s.sql))
        .pop();
      const firstPurge = touchingSession.findIndex(s => /^\s*DELETE/i.test(s.sql));
      expect(lastInsert).toBeDefined();
      expect(firstPurge).toBeGreaterThan((lastInsert as { i: number }).i);

      // The receipts specifically: replay re-inserts the target session's
      // receipt from `tool_operation_started` in the same stream, and the
      // tombstone has to remove it again. Without the purge line the row is
      // reproduced on every single rebuild.
      const receiptInsert = touchingSession.findIndex(s =>
        /INSERT[\s\S]*INTO tool_operation_receipts/i.test(s.sql)
      );
      const receiptPurge = touchingSession.findIndex(s =>
        /DELETE FROM tool_operation_receipts/i.test(s.sql)
      );
      expect(receiptInsert).toBeGreaterThanOrEqual(0);
      expect(receiptPurge).toBeGreaterThan(receiptInsert);

      // The rebuild must still restore the rest of the workspace.
      const writes = statements.filter(s => /^\s*INSERT/i.test(s.sql));
      expect(writes.some(s => JSON.stringify(s.params).includes(BYSTANDER))).toBe(true);
      expect(writes.some(s => JSON.stringify(s.params).includes(WS))).toBe(true);

      // The bystander session's receipt is a bystander too.
      const survivingReceipts = statements.filter(
        s => /INSERT[\s\S]*INTO tool_operation_receipts/i.test(s.sql)
          && JSON.stringify(s.params).includes(BYSTANDER)
      );
      expect(survivingReceipts.length).toBe(1);
      expect(
        statements.some(
          s => /DELETE FROM tool_operation_receipts/i.test(s.sql)
            && JSON.stringify(s.params).includes(BYSTANDER)
        )
      ).toBe(false);
    });
  });
});
