import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { NoteLink, TaskMetadata, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';

export interface TaskBoardTask extends TaskMetadata {
  projectName: string;
  workspaceName: string;
  noteLinks: NoteLink[];
}

export interface TaskBoardStats {
  taskCount: number;
  projectCount: number;
}

export interface SwimlaneGroup {
  parentId: string | null;
  parentTask: TaskBoardTask | null;
  children: TaskBoardTask[];
  progress: { done: number; total: number };
}

export type TaskSortField = 'created' | 'updated' | 'priority' | 'title' | 'dueDate';
export type TaskSortOrder = 'asc' | 'desc';

export const STATUS_COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' }
];

export const SORT_OPTIONS: Array<{ field: TaskSortField; label: string }> = [
  { field: 'created', label: 'Date created' },
  { field: 'updated', label: 'Last updated' },
  { field: 'priority', label: 'Priority' },
  { field: 'title', label: 'Title' },
  { field: 'dueDate', label: 'Due date' }
];

export const PRIORITY_ORDER: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4
};

export function projectBelongsToWorkspace(project: ProjectMetadata, workspaceId: string): boolean {
  return project.workspaceId === workspaceId;
}
