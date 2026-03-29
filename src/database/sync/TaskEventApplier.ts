/**
 * Location: src/database/sync/TaskEventApplier.ts
 *
 * Applies task-management events to SQLite cache.
 * Handles: project, task, dependency, and note-link events.
 *
 * Mirrors the pattern established by WorkspaceEventApplier.
 * Includes workspace ID normalization to fix orphaned data
 * where workspaceId is a name string instead of a UUID.
 */

import {
  TaskEvent,
  ProjectCreatedEvent,
  ProjectUpdatedEvent,
  ProjectDeletedEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  TaskDeletedEvent,
  TaskDependencyAddedEvent,
  TaskDependencyRemovedEvent,
  TaskNoteLinkedEvent,
  TaskNoteUnlinkedEvent,
} from '../interfaces/StorageEvents';
import { ISQLiteCacheManager } from './SyncCoordinator';
import { resolveWorkspaceId } from './resolveWorkspaceId';

/**
 * Normalize a workspaceId that may be a name string instead of a UUID.
 * Uses the shared resolveWorkspaceId helper. Falls back to the original
 * value if no match is found (data will be orphaned but won't crash).
 */
async function normalizeWorkspaceId(
  workspaceId: string,
  sqliteCache: ISQLiteCacheManager
): Promise<string> {
  if (!workspaceId) return workspaceId;

  const result = await resolveWorkspaceId(workspaceId, sqliteCache);

  if (result.warning) {
    console.error(`[TaskEventApplier] ${result.warning}`);
  }

  return result.id ?? workspaceId;
}

export class TaskEventApplier {
  private sqliteCache: ISQLiteCacheManager;

  constructor(sqliteCache: ISQLiteCacheManager) {
    this.sqliteCache = sqliteCache;
  }

  /**
   * Apply a task-related event to SQLite cache.
   */
  async apply(event: TaskEvent): Promise<void> {
    switch (event.type) {
      case 'project_created':
        await this.applyProjectCreated(event);
        break;
      case 'project_updated':
        await this.applyProjectUpdated(event);
        break;
      case 'project_deleted':
        await this.applyProjectDeleted(event);
        break;
      case 'task_created':
        await this.applyTaskCreated(event);
        break;
      case 'task_updated':
        await this.applyTaskUpdated(event);
        break;
      case 'task_deleted':
        await this.applyTaskDeleted(event);
        break;
      case 'task_dependency_added':
        await this.applyDependencyAdded(event);
        break;
      case 'task_dependency_removed':
        await this.applyDependencyRemoved(event);
        break;
      case 'task_note_linked':
        await this.applyNoteLinked(event);
        break;
      case 'task_note_unlinked':
        await this.applyNoteUnlinked(event);
        break;
    }
  }

  private async applyProjectCreated(event: ProjectCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.data?.name) return;

    const workspaceId = await normalizeWorkspaceId(
      event.data.workspaceId,
      this.sqliteCache
    );

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO projects
       (id, workspaceId, name, description, status, created, updated, metadataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        workspaceId,
        event.data.name,
        event.data.description ?? null,
        event.data.status ?? 'active',
        event.data.created ?? Date.now(),
        event.data.updated ?? Date.now(),
        event.data.metadataJson ?? null,
      ]
    );
  }

  private async applyProjectUpdated(event: ProjectUpdatedEvent): Promise<void> {
    if (!event.projectId) return;

    const updates: string[] = [];
    const values: any[] = [];

    if (event.data.name !== undefined) { updates.push('name = ?'); values.push(event.data.name); }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.status !== undefined) { updates.push('status = ?'); values.push(event.data.status); }
    if (event.data.updated !== undefined) { updates.push('updated = ?'); values.push(event.data.updated); }
    if (event.data.metadataJson !== undefined) { updates.push('metadataJson = ?'); values.push(event.data.metadataJson); }

    if (updates.length > 0) {
      values.push(event.projectId);
      await this.sqliteCache.run(
        `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  private async applyProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    if (!event.projectId) return;
    // CASCADE will handle tasks, dependencies, and note links
    await this.sqliteCache.run('DELETE FROM projects WHERE id = ?', [event.projectId]);
  }

  private async applyTaskCreated(event: TaskCreatedEvent): Promise<void> {
    if (!event.data?.id || !event.data?.projectId) return;

    const workspaceId = await normalizeWorkspaceId(
      event.data.workspaceId,
      this.sqliteCache
    );

    await this.sqliteCache.run(
      `INSERT OR REPLACE INTO tasks
       (id, projectId, workspaceId, parentTaskId, title, description, status, priority,
        created, updated, completedAt, dueDate, assignee, tagsJson, metadataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.data.id,
        event.data.projectId,
        workspaceId,
        event.data.parentTaskId ?? null,
        event.data.title,
        event.data.description ?? null,
        event.data.status ?? 'todo',
        event.data.priority ?? 'medium',
        event.data.created ?? Date.now(),
        event.data.updated ?? Date.now(),
        event.data.completedAt ?? null,
        event.data.dueDate ?? null,
        event.data.assignee ?? null,
        event.data.tagsJson ?? null,
        event.data.metadataJson ?? null,
      ]
    );
  }

  private async applyTaskUpdated(event: TaskUpdatedEvent): Promise<void> {
    if (!event.taskId) return;

    const updates: string[] = [];
    const values: any[] = [];

    if (event.data.projectId !== undefined) { updates.push('projectId = ?'); values.push(event.data.projectId); }
    if (event.data.parentTaskId !== undefined) { updates.push('parentTaskId = ?'); values.push(event.data.parentTaskId); }
    if (event.data.title !== undefined) { updates.push('title = ?'); values.push(event.data.title); }
    if (event.data.description !== undefined) { updates.push('description = ?'); values.push(event.data.description); }
    if (event.data.status !== undefined) { updates.push('status = ?'); values.push(event.data.status); }
    if (event.data.priority !== undefined) { updates.push('priority = ?'); values.push(event.data.priority); }
    if (event.data.updated !== undefined) { updates.push('updated = ?'); values.push(event.data.updated); }
    if (event.data.completedAt !== undefined) { updates.push('completedAt = ?'); values.push(event.data.completedAt); }
    if (event.data.dueDate !== undefined) { updates.push('dueDate = ?'); values.push(event.data.dueDate); }
    if (event.data.assignee !== undefined) { updates.push('assignee = ?'); values.push(event.data.assignee); }
    if (event.data.tagsJson !== undefined) { updates.push('tagsJson = ?'); values.push(event.data.tagsJson); }
    if (event.data.metadataJson !== undefined) { updates.push('metadataJson = ?'); values.push(event.data.metadataJson); }

    if (updates.length > 0) {
      values.push(event.taskId);
      await this.sqliteCache.run(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }
  }

  private async applyTaskDeleted(event: TaskDeletedEvent): Promise<void> {
    if (!event.taskId) return;
    await this.sqliteCache.run('DELETE FROM tasks WHERE id = ?', [event.taskId]);
  }

  private async applyDependencyAdded(event: TaskDependencyAddedEvent): Promise<void> {
    if (!event.taskId || !event.dependsOnTaskId) return;

    await this.sqliteCache.run(
      `INSERT OR IGNORE INTO task_dependencies (taskId, dependsOnTaskId, created)
       VALUES (?, ?, ?)`,
      [event.taskId, event.dependsOnTaskId, event.timestamp ?? Date.now()]
    );
  }

  private async applyDependencyRemoved(event: TaskDependencyRemovedEvent): Promise<void> {
    if (!event.taskId || !event.dependsOnTaskId) return;

    await this.sqliteCache.run(
      'DELETE FROM task_dependencies WHERE taskId = ? AND dependsOnTaskId = ?',
      [event.taskId, event.dependsOnTaskId]
    );
  }

  private async applyNoteLinked(event: TaskNoteLinkedEvent): Promise<void> {
    if (!event.taskId || !event.notePath) return;

    await this.sqliteCache.run(
      `INSERT OR IGNORE INTO task_note_links (taskId, notePath, linkType, created)
       VALUES (?, ?, ?, ?)`,
      [event.taskId, event.notePath, event.linkType ?? 'reference', event.timestamp ?? Date.now()]
    );
  }

  private async applyNoteUnlinked(event: TaskNoteUnlinkedEvent): Promise<void> {
    if (!event.taskId || !event.notePath) return;

    await this.sqliteCache.run(
      'DELETE FROM task_note_links WHERE taskId = ? AND notePath = ?',
      [event.taskId, event.notePath]
    );
  }
}
