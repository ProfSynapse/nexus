import type { ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { WorkspaceMetadata } from '../../../types/storage/StorageTypes';
import type { TaskBoardViewState } from '../taskBoardNavigation';
import {
  PRIORITY_ORDER,
  type TaskBoardStats,
  type TaskBoardTask,
  type TaskSortField,
  type TaskSortOrder,
  projectBelongsToWorkspace
} from '../taskBoardTypes';

export class TaskBoardFilterController {
  static normalizeState(state?: TaskBoardViewState): TaskBoardViewState {
    return {
      workspaceId: state?.workspaceId || '',
      projectId: state?.projectId || '',
      search: state?.search || '',
      sortField: state?.sortField || 'created',
      sortOrder: state?.sortOrder || 'asc'
    };
  }

  static ensureValidFilters(
    filterState: TaskBoardViewState,
    workspaces: WorkspaceMetadata[],
    projects: ProjectMetadata[]
  ): TaskBoardViewState {
    const nextState = this.normalizeState(filterState);
    const workspaceIds = new Set(workspaces.map(workspace => workspace.id));

    if (
      nextState.workspaceId &&
      nextState.workspaceId !== 'all' &&
      !workspaceIds.has(nextState.workspaceId)
    ) {
      nextState.workspaceId = 'all';
    }

    const availableProjectIds = new Set(
      this.getFilteredProjectsForToolbar(projects, nextState).map(project => project.id)
    );

    if (
      nextState.projectId &&
      nextState.projectId !== 'all' &&
      !availableProjectIds.has(nextState.projectId)
    ) {
      nextState.projectId = 'all';
    }

    return nextState;
  }

  static getFilteredProjectsForToolbar(
    projects: ProjectMetadata[],
    filterState: TaskBoardViewState
  ): ProjectMetadata[] {
    const workspaceId = filterState.workspaceId || '';
    if (!workspaceId || workspaceId === 'all') {
      return projects;
    }

    return projects.filter(project => projectBelongsToWorkspace(project, workspaceId));
  }

  static getFilteredAndSortedTasks(
    tasks: TaskBoardTask[],
    filterState: TaskBoardViewState
  ): TaskBoardTask[] {
    const normalizedState = this.normalizeState(filterState);
    const searchQuery = normalizedState.search?.trim().toLowerCase() || '';

    const filtered = tasks.filter(task => {
      const matchesWorkspace = !normalizedState.workspaceId ||
        normalizedState.workspaceId === 'all' ||
        task.workspaceId === normalizedState.workspaceId;
      const matchesProject = !normalizedState.projectId ||
        normalizedState.projectId === 'all' ||
        task.projectId === normalizedState.projectId;

      if (!matchesWorkspace || !matchesProject) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const haystack = [
        task.title,
        task.description,
        task.projectName,
        task.workspaceName,
        task.assignee,
        task.tags?.join(', ')
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(searchQuery);
    });

    const sortField = normalizedState.sortField as TaskSortField;
    const sortOrder = normalizedState.sortOrder as TaskSortOrder;
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    filtered.sort((a, b) => this.compareTasksByField(a, b, sortField) * multiplier);

    return filtered;
  }

  static getStats(tasks: TaskBoardTask[]): TaskBoardStats {
    return {
      taskCount: tasks.length,
      projectCount: new Set(tasks.map(task => task.projectId)).size
    };
  }

  static compareTasksByField(
    left: TaskBoardTask,
    right: TaskBoardTask,
    sortField: TaskSortField
  ): number {
    switch (sortField) {
      case 'created':
        return left.created - right.created;
      case 'updated':
        return left.updated - right.updated;
      case 'priority':
        return (PRIORITY_ORDER[left.priority] ?? 5) - (PRIORITY_ORDER[right.priority] ?? 5);
      case 'title':
        return left.title.localeCompare(right.title);
      case 'dueDate': {
        const leftDue = left.dueDate ?? Number.MAX_SAFE_INTEGER;
        const rightDue = right.dueDate ?? Number.MAX_SAFE_INTEGER;
        return leftDue - rightDue;
      }
    }
  }
}
