/**
 * Regression tests for two storage update bugs surfaced by the Phase 0
 * characterization pass (see docs/plans/hybrid-storage-adapter-split-plan.md):
 *  1. updateSession silently dropped startTime end-to-end (adapter delegate,
 *     UpdateSessionData, SessionUpdatedEvent, SQL, and rebuild fold all
 *     omitted it).
 *  2. MessageRepository.update ignored the conversationId the adapter was
 *     given, so an update aimed at conversation X silently applied to a
 *     message in conversation Y.
 */

import { SessionRepository } from '../../src/database/repositories/SessionRepository';
import { MessageRepository } from '../../src/database/repositories/MessageRepository';
import type { SessionUpdatedEvent } from '../../src/database/interfaces/StorageEvents';

type AnyRecord = Record<string, unknown>;

function makeSessionRepo(): {
  repo: SessionRepository;
  writeEvent: jest.Mock;
  run: jest.Mock;
} {
  const repo = Object.create(SessionRepository.prototype) as SessionRepository & AnyRecord;
  const writeEvent = jest.fn().mockResolvedValue(undefined);
  const run = jest.fn().mockResolvedValue(undefined);
  Object.assign(repo, {
    jsonlPath: (id: string) => `workspaces/ws_${id}.jsonl`,
    writeEvent,
    transaction: (fn: () => Promise<void>) => fn(),
    sqliteCache: { run },
    queryCache: { invalidateByType: jest.fn() },
    invalidateCache: jest.fn(),
    log: jest.fn(),
    logError: jest.fn()
  });
  return { repo, writeEvent, run };
}

describe('SessionRepository.update startTime passthrough', () => {
  it('writes startTime into the JSONL event and the SQL update', async () => {
    const { repo, writeEvent, run } = makeSessionRepo();

    await repo.update('session-1', {
      name: 'Renamed',
      startTime: 999,
      workspaceId: 'ws-1'
    });

    const event = writeEvent.mock.calls[0][1] as SessionUpdatedEvent;
    expect(event.type).toBe('session_updated');
    expect(event.data.startTime).toBe(999);

    const [sql, params] = run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('startTime = ?');
    expect(params).toContain(999);
  });

  it('omits startTime from SQL when not provided', async () => {
    const { repo, run } = makeSessionRepo();

    await repo.update('session-1', { name: 'Renamed', workspaceId: 'ws-1' });

    const [sql] = run.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('startTime');
  });
});

describe('MessageRepository.update conversationId validation', () => {
  function makeMessageRepo(currentConversationId: string): MessageRepository {
    const repo = Object.create(MessageRepository.prototype) as MessageRepository & AnyRecord;
    Object.assign(repo, {
      getById: jest.fn().mockResolvedValue({
        id: 'msg-1',
        conversationId: currentConversationId,
        role: 'user',
        content: 'hi',
        timestamp: 1,
        state: 'complete',
        sequenceNumber: 0,
        activeAlternativeIndex: 0
      }),
      logError: jest.fn()
    });
    return repo;
  }

  it('throws when the message belongs to a different conversation', async () => {
    const repo = makeMessageRepo('conv-REAL');

    await expect(
      repo.update('msg-1', { content: 'edited' }, 'conv-WRONG')
    ).rejects.toThrow('belongs to conversation conv-REAL, not conv-WRONG');
  });

  it('proceeds when the conversationId matches (no-op update returns cleanly)', async () => {
    const repo = makeMessageRepo('conv-1');

    // content identical to current -> hasChanges is false -> returns before
    // any JSONL/SQL infrastructure is touched.
    await expect(repo.update('msg-1', { content: 'hi' }, 'conv-1')).resolves.toBeUndefined();
  });

  it('skips validation when no expected conversationId is provided', async () => {
    const repo = makeMessageRepo('conv-REAL');

    await expect(repo.update('msg-1', { content: 'hi' })).resolves.toBeUndefined();
  });
});
