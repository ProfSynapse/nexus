/**
 * Location: src/database/sync/WorkspaceEventApplier.ts
 *
 * Applies workspace-related events to SQLite cache.
 * Handles: workspace, session, state, trace events.
 */

import {
  WorkspaceEvent,
  WorkspaceCreatedEvent,
  WorkspaceUpdatedEvent,
  WorkspaceDeletedEvent,
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionDeletedEvent,
  StateSavedEvent,
  StateUpdatedEvent,
  StateDeletedEvent,
  TraceAddedEvent,
  ToolOperationStartedEvent,
  ToolOperationCompletedEvent,
  ToolOperationFailedEvent,
  ToolOperationIndeterminateEvent,
} from '../interfaces/StorageEvents';
import { ISQLiteCacheManager } from './SyncCoordinator';
import { purgeWorkspaceRows } from '../workspaceOwnership';
import { purgeSessionRows } from '../sessionOwnership';
import { deriveStateMetadataFromJson, resolveStateDescription } from '../utils/stateContent';

export class WorkspaceEventApplier {
  private sqliteCache: ISQLiteCacheManager;

  constructor(sqliteCache: ISQLiteCacheManager) {
    this.sqliteCache = sqliteCache;
  }

  /**
   * Validate workspace ID to prevent ghost/orphan workspaces.
   * Rejects "undefined", "null", and empty/whitespace-only IDs.
   */
  private isValidWorkspaceId(id: string | undefined): boolean {
    return !!id && id !== 'undefined' && id !== 'null' && id.trim().length > 0;
  }

  /**
   * Apply a workspace-related event to SQLite cache.
   */
  async apply(event: WorkspaceEvent): Promise<boolean | void> {
    switch (event.type) {
      case 'workspace_created':
        await this.applyWorkspaceCreated(event);
        break;
      case 'workspace_updated':
        await this.applyWorkspaceUpdated(event);
        break;
      case 'workspace_deleted':
        await this.applyWorkspaceDeleted(event);
        break;
      case 'session_created':
        await this.applySessionCreated(event);
        break;
      case 'session_updated':
        await this.applySessionUpdated(event);
        break;
      case 'session_deleted':
        await this.applySessionDeleted(event);
        break;
      case 'state_saved':
        await this.applyStateSaved(event);
        break;
      case 'state_updated':
        await this.applyStateUpdated(event);
        break;
      case 'state_deleted':
        await this.applyStateDeleted(event);
        break;
      case 'trace_added':
        await this.applyTraceAdded(event);
        break;
      case 'tool_operation_started':
        return this.applyToolOperationStarted(event);
      case 'tool_operation_completed':
        await this.applyToolOperationCompleted(event);
        break;
      case 'tool_operation_failed':
        await this.applyToolOperationFailed(event);
        break;
      case 'tool_operation_indeterminate':
        await this.applyToolOperationIndeterminate(event);
        break;
    }
  }

  private async applyWorkspaceCreated(event: WorkspaceCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.data?.name) {
      return;
    }
    if (!this.isValidWorkspaceId(event.data.id)) {
      return;
    }

    // A create for an id that already has a row is a duplicate, not a reset.
    // Plugin builds 5.17.0-5.20.4 appended a fresh `workspace_created` for the
    // default workspace on every load (DefaultWorkspaceManager raced startup),
    // so those streams interleave duplicates with real `workspace_updated`
    // events. Replaying a duplicate as INSERT OR REPLACE reverted every edit
    // made before it. First create wins; later ones are no-ops. A create after
    // `workspace_deleted` still lands, because the delete purged the row.
    const existing = await this.sqliteCache.queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = ?',
      [event.data.id]
    );
    if (existing) {
      return;
    }

    const created = event.data.created ?? event.timestamp ?? Date.now();
    const name = await this.claimNameForCreate(event.data.id, event.data.name, created);

    await this.sqliteCache.run(
      `INSERT INTO workspaces
       (id, name, description, rootFolder, created, lastAccessed, isActive, isArchived, contextJson, dedicatedAgentId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        name,
        event.data.description ?? null,
        event.data.rootFolder ?? '',
        created,
        created,
        // Default to 1 (active) if not specified
        event.data.isActive !== undefined ? (event.data.isActive ? 1 : 0) : 1,
        event.data.isArchived !== undefined ? (event.data.isArchived ? 1 : 0) : 0,
        event.data.contextJson ?? null,
        event.data.dedicatedAgentId ?? null
      ]
    );
  }

  /**
   * Decide which name a replayed `workspace_created` gets when another
   * workspace (a different id) already holds that name.
   *
   * `UNIQUE(name)` used to be resolved by INSERT OR REPLACE, which DELETES the
   * row holding the name. Two workspaces with one name in the event store is
   * real history — 5.17-5.20.x appended a `workspace_created` even when the
   * live INSERT then failed on the name, and two devices can each create
   * "Project X" before they sync — so a rebuild silently dropped whichever
   * workspace was replayed first, its edits, and the parent row of its
   * sessions, states, traces, projects, tasks and conversations.
   *
   * Rule: both workspaces keep their rows and ids, so every reference to either
   * id still resolves. The earliest-created one (ties: smaller id) keeps the
   * plain name; the other is shown as "<name> (<id>)". Deciding by `created`
   * rather than by arrival makes the result independent of the order the
   * shard files are listed in. Merging the two under one id (aliasing) was
   * rejected: every applier and every live lookup by id would need to learn
   * the alias, and two genuinely different workspaces would be fused.
   *
   * Returns the name the incoming row should be inserted with. When the
   * incoming workspace is the earlier one, the current holder is renamed out
   * of the way first.
   */
  private async claimNameForCreate(id: string, name: string, created: number): Promise<string> {
    const holder = await this.sqliteCache.queryOne<{ id: string; created: number | null }>(
      'SELECT id, created FROM workspaces WHERE name = ? AND id != ?',
      [name, id]
    );
    if (!holder) {
      return name;
    }

    const holderCreated = typeof holder.created === 'number' ? holder.created : Number.POSITIVE_INFINITY;
    const incomingWins = created < holderCreated || (created === holderCreated && id < holder.id);
    if (!incomingWins) {
      return this.disambiguatedName(name, id);
    }

    await this.sqliteCache.run(
      'UPDATE workspaces SET name = ? WHERE id = ?',
      [await this.disambiguatedName(name, holder.id), holder.id]
    );
    return name;
  }

  /**
   * "<name> (<id>)" — derived from the id so the same history always yields
   * the same name, with a counter only if a user already chose that exact text.
   */
  private async disambiguatedName(name: string, id: string): Promise<string> {
    const base = `${name} (${id})`;
    let candidate = base;
    for (let n = 2; ; n++) {
      const taken = await this.sqliteCache.queryOne<{ id: string }>(
        'SELECT id FROM workspaces WHERE name = ? AND id != ?',
        [candidate, id]
      );
      if (!taken) {
        return candidate;
      }
      candidate = `${base} ${n}`;
    }
  }

  private async applyWorkspaceUpdated(event: WorkspaceUpdatedEvent): Promise<void> {
    if (!this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (event.data.name !== undefined) {
      // A rename onto a name another workspace holds would fail UNIQUE(name)
      // and take the rest of this event (description, context, archive flag)
      // down with it. Such events exist: the live update appended its event
      // before SQLite rejected the name. Keep the rest, and give the name the
      // same "<name> (<id>)" form a colliding create gets.
      const holder = await this.sqliteCache.queryOne<{ id: string }>(
        'SELECT id FROM workspaces WHERE name = ? AND id != ?',
        [event.data.name, event.workspaceId]
      );
      const name = holder ? await this.disambiguatedName(event.data.name, event.workspaceId) : event.data.name;
      updates.push('name = ?'); values.push(name);
    }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.rootFolder !== undefined) { updates.push('rootFolder = ?'); values.push(event.data.rootFolder); }
    if (event.data.lastAccessed !== undefined) { updates.push('lastAccessed = ?'); values.push(event.data.lastAccessed); }
    if (event.data.isActive !== undefined) { updates.push('isActive = ?'); values.push(event.data.isActive ? 1 : 0); }
    if (event.data.isArchived !== undefined) { updates.push('isArchived = ?'); values.push(event.data.isArchived ? 1 : 0); }
    if (event.data.contextJson !== undefined) { updates.push('contextJson = ?'); values.push(event.data.contextJson); }
    if (event.data.dedicatedAgentId !== undefined) { updates.push('dedicatedAgentId = ?'); values.push(event.data.dedicatedAgentId); }

    if (updates.length > 0) {
      values.push(event.workspaceId);
      await this.sqliteCache.run(
        `UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  /**
   * A `workspace_deleted` event has to remove everything the workspace owns,
   * not just its row.
   *
   * This runs during replay — `rebuildCache()` and cross-device sync — where the
   * events that created the workspace's sessions, states and traces have already
   * been applied from the same stream moments earlier. Deleting only the
   * `workspaces` row left every one of those children behind as an orphan that
   * reappeared on every rebuild: the schema declares `ON DELETE CASCADE`, but FK
   * enforcement is off on the shared connection, so nothing cascaded.
   *
   * `purgeWorkspaceRows` is shared with `WorkspaceRepository.delete` precisely so
   * the live delete and the replay of that delete cannot drift apart.
   */
  private async applyWorkspaceDeleted(event: WorkspaceDeletedEvent): Promise<void> {
    if (!this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }
    await purgeWorkspaceRows(this.sqliteCache, event.workspaceId);
  }

  private async applySessionCreated(event: SessionCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.workspaceId) {
      return;
    }
    if (!this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO sessions
       (id, workspaceId, name, description, startTime, isActive)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.workspaceId,
        event.data.name ?? 'Unnamed Session',
        event.data.description ?? null,
        event.data.startTime ?? Date.now(),
        1
      ]
    );
  }

  /**
   * A `session_deleted` event has to remove everything the session owns, not
   * just its row.
   *
   * This runs during replay — `rebuildCache()` and cross-device sync — where the
   * `session_created`, `state_saved` and `trace_added` events for this session
   * were applied from the same workspace stream moments earlier. The tombstone
   * is what cancels them out; a session has no stream of its own to remove.
   *
   * `purgeSessionRows` is shared with `SessionRepository.delete` precisely so
   * the live delete and the replay of that delete cannot drift apart.
   */
  private async applySessionDeleted(event: SessionDeletedEvent): Promise<void> {
    if (!event.sessionId) {
      return;
    }
    await purgeSessionRows(this.sqliteCache, event.sessionId);
  }

  private async applySessionUpdated(event: SessionUpdatedEvent): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (event.data.name !== undefined) { updates.push('name = ?'); values.push(event.data.name); }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.startTime !== undefined) { updates.push('startTime = ?'); values.push(event.data.startTime); }
    if (event.data.endTime !== undefined) { updates.push('endTime = ?'); values.push(event.data.endTime); }
    if (event.data.isActive !== undefined) { updates.push('isActive = ?'); values.push(event.data.isActive ? 1 : 0); }
    if (event.data.workspaceId !== undefined) { updates.push('workspaceId = ?'); values.push(event.data.workspaceId); }

    if (updates.length > 0) {
      values.push(event.sessionId);
      await this.sqliteCache.run(
        `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  private async applyStateSaved(event: StateSavedEvent): Promise<void> {
    if (!event.data?.id || !event.sessionId || !event.workspaceId) {
      return;
    }
    if (!this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }

    // Derive the denormalized columns from the snapshot exactly as
    // StateRepository.saveState does on the live write path. If these two
    // diverge, "Nexus: Rebuild cache" quietly changes which states are listed.
    const derived = deriveStateMetadataFromJson(event.data.stateJson);

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO states
       (id, sessionId, workspaceId, name, description, created, stateJson, tagsJson, isArchived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.sessionId,
        event.workspaceId,
        event.data.name ?? 'Unnamed State',
        resolveStateDescription(event.data.description, derived),
        event.data.created ?? Date.now(),
        event.data.stateJson ?? '{}',
        event.data.tags ? JSON.stringify(event.data.tags) : null,
        // NULL (unparseable stateJson) leaves the flag unknown rather than
        // asserting "not archived"; MemoryService then falls back to content.
        derived ? (derived.isArchived ? 1 : 0) : null
      ]
    );
  }

  private async applyStateUpdated(event: StateUpdatedEvent): Promise<void> {
    if (!event.stateId) {
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (event.data.name !== undefined) {
      updates.push('name = ?');
      values.push(event.data.name);
    }
    if (event.data.description !== undefined) {
      updates.push('description = ?');
      values.push(event.data.description);
    }
    if (event.data.tags !== undefined) {
      updates.push('tagsJson = ?');
      values.push(JSON.stringify(event.data.tags));
    }
    if (event.data.stateJson !== undefined) {
      // The full snapshot still lives in JSONL only — but the archive flag
      // denormalized out of it (issue #219) has to follow content updates,
      // because archiving a state IS a content update. Without this, a replay
      // of state_saved + state_updated would resurrect archived states.
      const derived = deriveStateMetadataFromJson(event.data.stateJson);
      if (derived) {
        updates.push('isArchived = ?');
        values.push(derived.isArchived ? 1 : 0);
      }
      // The applier keeps a copy of the snapshot for rows it owns, so the
      // stateJson column has to track the update too — otherwise the v16
      // backfill would read a stale snapshot out of it.
      updates.push('stateJson = ?');
      values.push(event.data.stateJson);
    }

    if (updates.length > 0) {
      values.push(event.stateId);
      await this.sqliteCache.run(
        `UPDATE states SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  private async applyStateDeleted(event: StateDeletedEvent): Promise<void> {
    await this.sqliteCache.run('DELETE FROM states WHERE id = ?', [event.stateId]);
  }

  private async applyTraceAdded(event: TraceAddedEvent): Promise<void> {
    if (!event.data?.id || !event.sessionId || !event.workspaceId) {
      return;
    }
    if (!this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO memory_traces
       (id, sessionId, workspaceId, timestamp, type, content, metadataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.sessionId,
        event.workspaceId,
        event.timestamp ?? Date.now(),
        event.data.traceType ?? null,
        event.data.content ?? '',
        event.data.metadataJson ?? null
      ]
    );
  }

  private async applyToolOperationStarted(event: ToolOperationStartedEvent): Promise<boolean> {
    const data = event.data;
    if (!data?.operationId || !data.signature || !this.isValidWorkspaceId(data.workspaceId)) {
      return false;
    }

    // The first signature observed for an operation id wins. A conflicting
    // replay remains visible to the execution layer instead of overwriting the
    // original receipt during multi-device reconciliation.
    const result = await this.sqliteCache.run(
      `INSERT OR IGNORE INTO tool_operation_receipts
       (operationId, signature, status, origin, workspaceId, sessionId,
        conversationId, messageId, turnId, replayPolicy, replayable,
        commandSummary, resultJson, resultTruncated, error, startedAt,
        completedAt, updatedAt)
       VALUES (?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, NULL, ?)`,
      [
        data.operationId,
        data.signature,
        data.origin,
        data.workspaceId,
        data.sessionId,
        data.conversationId ?? null,
        data.messageId ?? null,
        data.turnId ?? null,
        data.replayPolicy,
        data.replayable ? 1 : 0,
        data.commandSummary,
        event.timestamp,
        event.timestamp,
      ]
    );
    return hasRunChanges(result) && result.changes === 1;
  }

  private async applyToolOperationCompleted(event: ToolOperationCompletedEvent): Promise<void> {
    await this.applyToolOperationTerminal(event, 'completed', event.resultJson, event.resultTruncated, null);
  }

  private async applyToolOperationFailed(event: ToolOperationFailedEvent): Promise<void> {
    await this.applyToolOperationTerminal(event, 'failed', null, false, event.error);
  }

  private async applyToolOperationIndeterminate(event: ToolOperationIndeterminateEvent): Promise<void> {
    await this.applyToolOperationTerminal(event, 'indeterminate', null, false, event.error);
  }

  private async applyToolOperationTerminal(
    event: ToolOperationCompletedEvent | ToolOperationFailedEvent | ToolOperationIndeterminateEvent,
    status: 'completed' | 'failed' | 'indeterminate',
    resultJson: string | null,
    resultTruncated: boolean,
    error: string | null
  ): Promise<void> {
    if (!event.operationId || !event.signature || !this.isValidWorkspaceId(event.workspaceId)) {
      return;
    }
    await this.sqliteCache.run(
      `UPDATE tool_operation_receipts
       SET status = ?, resultJson = ?, resultTruncated = ?, error = ?, completedAt = ?, updatedAt = ?
       WHERE operationId = ? AND signature = ?`,
      [
        status,
        resultJson,
        resultTruncated ? 1 : 0,
        error,
        event.completedAt,
        event.timestamp,
        event.operationId,
        event.signature,
      ]
    );
  }
}

function hasRunChanges(value: unknown): value is { changes: number } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { changes?: unknown }).changes === 'number';
}
