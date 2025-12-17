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
  StateSavedEvent,
  StateDeletedEvent,
  TraceAddedEvent,
} from '../interfaces/StorageEvents';
import { ISQLiteCacheManager } from './SyncCoordinator';

export class WorkspaceEventApplier {
  private sqliteCache: ISQLiteCacheManager;

  constructor(sqliteCache: ISQLiteCacheManager) {
    this.sqliteCache = sqliteCache;
  }

  /**
   * Apply a workspace-related event to SQLite cache.
   */
  async apply(event: WorkspaceEvent): Promise<void> {
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
      case 'state_saved':
        await this.applyStateSaved(event);
        break;
      case 'state_deleted':
        await this.applyStateDeleted(event);
        break;
      case 'trace_added':
        await this.applyTraceAdded(event);
        break;
    }
  }

  private async applyWorkspaceCreated(event: WorkspaceCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.data?.name) {
      return;
    }

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO workspaces
       (id, name, description, rootFolder, created, lastAccessed, isActive, contextJson, dedicatedAgentId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.data.name,
        event.data.description ?? null,
        event.data.rootFolder ?? '',
        event.data.created ?? Date.now(),
        event.data.created ?? Date.now(),
        // Default to 1 (active) if not specified
        event.data.isActive !== undefined ? (event.data.isActive ? 1 : 0) : 1,
        event.data.contextJson ?? null,
        event.data.dedicatedAgentId ?? null
      ]
    );
  }

  private async applyWorkspaceUpdated(event: WorkspaceUpdatedEvent): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];

    if (event.data.name !== undefined) { updates.push('name = ?'); values.push(event.data.name); }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.rootFolder !== undefined) { updates.push('rootFolder = ?'); values.push(event.data.rootFolder); }
    if (event.data.lastAccessed !== undefined) { updates.push('lastAccessed = ?'); values.push(event.data.lastAccessed); }
    if (event.data.isActive !== undefined) { updates.push('isActive = ?'); values.push(event.data.isActive ? 1 : 0); }
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

  private async applyWorkspaceDeleted(event: WorkspaceDeletedEvent): Promise<void> {
    await this.sqliteCache.run('DELETE FROM workspaces WHERE id = ?', [event.workspaceId]);
  }

  private async applySessionCreated(event: SessionCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.workspaceId) {
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

  private async applySessionUpdated(event: SessionUpdatedEvent): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];

    if (event.data.name !== undefined) { updates.push('name = ?'); values.push(event.data.name); }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.endTime !== undefined) { updates.push('endTime = ?'); values.push(event.data.endTime); }
    if (event.data.isActive !== undefined) { updates.push('isActive = ?'); values.push(event.data.isActive ? 1 : 0); }

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

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO states
       (id, sessionId, workspaceId, name, description, created, stateJson, tagsJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.sessionId,
        event.workspaceId,
        event.data.name ?? 'Unnamed State',
        event.data.description ?? null,
        event.data.created ?? Date.now(),
        event.data.stateJson ?? '{}',
        event.data.tags ? JSON.stringify(event.data.tags) : null
      ]
    );
  }

  private async applyStateDeleted(event: StateDeletedEvent): Promise<void> {
    await this.sqliteCache.run('DELETE FROM states WHERE id = ?', [event.stateId]);
  }

  private async applyTraceAdded(event: TraceAddedEvent): Promise<void> {
    if (!event.data?.id || !event.sessionId || !event.workspaceId) {
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
}
