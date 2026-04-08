import { Notice, type App } from 'obsidian';
import type { LinkType } from '../../../database/repositories/interfaces/ITaskRepository';
import type { ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { TaskService } from '../../../agents/taskManager/services/TaskService';
import type { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import {
  TaskBoardEditModal,
  type TaskBoardEditableTask,
  type TaskBoardParentTaskOption,
  type TaskBoardProjectOption
} from '../TaskBoardEditModal';
import type { TaskBoardTask } from '../taskBoardTypes';

interface TaskBoardEditCoordinatorDependencies {
  app: App;
  getTaskService: () => TaskService | null;
  getProjects: () => ProjectMetadata[];
  getTasks: () => TaskBoardTask[];
  getEmbeddingService: () => EmbeddingService | undefined;
  reloadBoard: () => Promise<void>;
  renderBoard: () => void;
  onEditModalStateChange: (isOpen: boolean) => void;
  onEditModalClose: () => void;
  toDateInputValue: (timestamp?: number) => string;
  fromDateInputValue: (value: string) => number | undefined;
}

export class TaskBoardEditCoordinator {
  constructor(private readonly deps: TaskBoardEditCoordinatorDependencies) {}

  openEditModal(task: TaskBoardTask): void {
    this.deps.onEditModalStateChange(true);

    new TaskBoardEditModal(this.deps.app, {
      task: this.buildEditableTask(task),
      projects: this.buildProjectOptions(task),
      parentTasks: this.buildParentTaskOptions(task),
      embeddingService: this.deps.getEmbeddingService(),
      onSave: async (updatedTask) => {
        await this.saveTaskChanges(task, updatedTask);
      },
      onClose: () => {
        this.deps.onEditModalStateChange(false);
        this.deps.onEditModalClose();
      }
    }).open();
  }

  async saveTaskChanges(originalTask: TaskBoardTask, updatedTask: TaskBoardEditableTask): Promise<void> {
    const taskService = this.deps.getTaskService();
    if (!taskService) {
      throw new Error('Task service is not available');
    }

    const normalizedTags = updatedTask.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);

    await taskService.updateTask(originalTask.id, {
      title: updatedTask.title.trim(),
      description: updatedTask.description.trim() || undefined,
      status: updatedTask.status,
      priority: updatedTask.priority,
      dueDate: this.deps.fromDateInputValue(updatedTask.dueDate),
      assignee: updatedTask.assignee.trim() || undefined,
      tags: normalizedTags.length > 0 ? normalizedTags : undefined
    });

    const projectChanged = updatedTask.projectId !== originalTask.projectId;
    const parentChanged = (updatedTask.parentTaskId || '') !== (originalTask.parentTaskId || '');
    if (projectChanged || parentChanged) {
      await taskService.moveTask(originalTask.id, {
        projectId: projectChanged ? updatedTask.projectId : undefined,
        parentTaskId: parentChanged ? (updatedTask.parentTaskId || null) : undefined
      });
    }

    const originalPaths = new Set(originalTask.noteLinks.map(link => link.notePath));
    const updatedLinks = updatedTask.noteLinks.filter(link => link.notePath.trim());
    const updatedPaths = new Map<string, LinkType>(
      updatedLinks.map(link => [link.notePath.trim(), link.linkType || 'reference'])
    );

    for (const path of originalPaths) {
      if (!updatedPaths.has(path)) {
        await taskService.unlinkNote(originalTask.id, path);
      }
    }

    for (const [path, linkType] of updatedPaths) {
      if (!originalPaths.has(path)) {
        await taskService.linkNote(originalTask.id, path, linkType);
      }
    }

    await this.deps.reloadBoard();
    this.deps.renderBoard();
    new Notice('Task saved');
  }

  private buildEditableTask(task: TaskBoardTask): TaskBoardEditableTask {
    return {
      id: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      dueDate: this.deps.toDateInputValue(task.dueDate),
      assignee: task.assignee || '',
      tags: task.tags?.join(', ') || '',
      parentTaskId: task.parentTaskId || '',
      noteLinks: [...task.noteLinks]
    };
  }

  private buildProjectOptions(task: TaskBoardTask): TaskBoardProjectOption[] {
    return this.deps.getProjects()
      .filter(project => project.workspaceId === task.workspaceId)
      .map<TaskBoardProjectOption>(project => ({
        id: project.id,
        name: project.name
      }));
  }

  private buildParentTaskOptions(task: TaskBoardTask): TaskBoardParentTaskOption[] {
    return this.deps.getTasks()
      .filter(candidate => candidate.workspaceId === task.workspaceId && candidate.id !== task.id)
      .map<TaskBoardParentTaskOption>(candidate => ({
        id: candidate.id,
        title: candidate.title,
        projectId: candidate.projectId
      }));
  }
}
