import type { TaskBoardViewState } from '../taskBoardNavigation';
import type { SwimlaneGroup, TaskBoardTask, TaskSortField, TaskSortOrder } from '../taskBoardTypes';
import { TaskBoardFilterController } from './TaskBoardFilterController';

export class TaskBoardGroupingService {
  static groupTasksByParent(
    allTasks: TaskBoardTask[],
    columnTasks: TaskBoardTask[],
    filterState: TaskBoardViewState
  ): SwimlaneGroup[] {
    const allTaskMap = new Map(allTasks.map(task => [task.id, task]));
    const parentIdsWithChildren = new Set<string>();

    for (const task of TaskBoardFilterController.getFilteredAndSortedTasks(allTasks, filterState)) {
      if (task.parentTaskId && task.parentTaskId !== task.id && allTaskMap.has(task.parentTaskId)) {
        parentIdsWithChildren.add(task.parentTaskId);
      }
    }

    const grouped = new Map<string, TaskBoardTask[]>();
    const ungrouped: TaskBoardTask[] = [];

    for (const task of columnTasks) {
      if (parentIdsWithChildren.has(task.id)) {
        continue;
      }

      const parentId = task.parentTaskId;
      if (
        parentId &&
        parentId !== task.id &&
        allTaskMap.has(parentId) &&
        parentIdsWithChildren.has(parentId)
      ) {
        const existing = grouped.get(parentId);
        if (existing) {
          existing.push(task);
        } else {
          grouped.set(parentId, [task]);
        }
      } else {
        ungrouped.push(task);
      }
    }

    const groups: SwimlaneGroup[] = [];
    for (const [parentId, children] of grouped) {
      groups.push({
        parentId,
        parentTask: allTaskMap.get(parentId) || null,
        children,
        progress: this.getParentProgress(parentId, parentIdsWithChildren, allTasks, filterState)
      });
    }

    const sortField = (filterState.sortField || 'created') as TaskSortField;
    const sortOrder = (filterState.sortOrder || 'asc') as TaskSortOrder;
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    groups.sort((left, right) => {
      if (!left.parentTask || !right.parentTask) {
        return 0;
      }

      return TaskBoardFilterController.compareTasksByField(
        left.parentTask,
        right.parentTask,
        sortField
      ) * multiplier;
    });

    if (ungrouped.length > 0) {
      groups.push({
        parentId: null,
        parentTask: null,
        children: ungrouped,
        progress: { done: 0, total: 0 }
      });
    }

    return groups;
  }

  private static getParentProgress(
    parentTaskId: string,
    parentIds: Set<string>,
    allTasks: TaskBoardTask[],
    filterState: TaskBoardViewState
  ): { done: number; total: number } {
    const children = allTasks.filter(task => {
      if (task.parentTaskId !== parentTaskId) {
        return false;
      }
      if (parentIds.has(task.id)) {
        return false;
      }

      const matchesWorkspace = !filterState.workspaceId ||
        filterState.workspaceId === 'all' ||
        task.workspaceId === filterState.workspaceId;
      const matchesProject = !filterState.projectId ||
        filterState.projectId === 'all' ||
        task.projectId === filterState.projectId;

      return matchesWorkspace && matchesProject;
    });

    return {
      done: children.filter(task => task.status === 'done').length,
      total: children.length
    };
  }
}
