/**
 * ProjectsManagerView — Manages project/task state and CRUD coordination.
 * Delegates rendering to WorkspaceDetailRenderer.
 * Extracted from WorkspacesTab to keep the tab under 600 lines.
 */

import { Notice } from 'obsidian';
import { WorkspaceDetailRenderer, DetailCallbacks } from './WorkspaceDetailRenderer';
import { ProjectWorkspace } from '../../database/workspace-types';
import { TaskService } from '../../agents/taskManager/services/TaskService';
import { DAGService } from '../../agents/taskManager/services/DAGService';
import type { ServiceManager } from '../../core/ServiceManager';
import type { HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskPriority, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';

type ProjectStatus = ProjectMetadata['status'];

interface ProjectEditorState {
    id?: string;
    workspaceId: string;
    name: string;
    description: string;
    status: ProjectStatus;
}

interface TaskEditorState {
    id?: string;
    projectId: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string;
    assignee: string;
    tags: string;
    parentTaskId: string;
}

export interface ProjectsManagerCallbacks {
    getCurrentWorkspace: () => Partial<ProjectWorkspace> | null;
    onNavigateList: () => void;
    onNavigateDetail: () => void;
    onRender: () => void;
    buildDetailCallbacks: () => DetailCallbacks;
}

export type ProjectsView = 'projects' | 'project-detail' | 'task-detail';

export class ProjectsManagerView {
    private detailRenderer: WorkspaceDetailRenderer;
    private serviceManager?: ServiceManager;
    private callbacks: ProjectsManagerCallbacks;

    // Project/task state
    private currentProjects: ProjectMetadata[] = [];
    private currentProject: ProjectEditorState | null = null;
    private currentTasks: TaskMetadata[] = [];
    private currentTask: TaskEditorState | null = null;
    private editingTaskOriginal: TaskMetadata | null = null;
    private taskService: TaskService | null | undefined;

    constructor(
        detailRenderer: WorkspaceDetailRenderer,
        serviceManager: ServiceManager | undefined,
        callbacks: ProjectsManagerCallbacks
    ) {
        this.detailRenderer = detailRenderer;
        this.serviceManager = serviceManager;
        this.callbacks = callbacks;
    }

    // --- Public render methods (called by WorkspacesTab.render()) ---

    renderProjects(container: HTMLElement): void {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace) return;

        this.detailRenderer.renderProjects(
            container,
            workspace,
            this.currentProjects,
            this.currentTasks,
            this.callbacks.buildDetailCallbacks()
        );
    }

    renderProjectDetail(container: HTMLElement): void {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace || !this.currentProject) return;

        this.detailRenderer.renderProjectDetail(
            container,
            workspace,
            this.currentProject,
            this.currentTasks,
            this.currentProjects,
            this.callbacks.buildDetailCallbacks(),
            () => this.saveProjectDetail(),
            (task?) => this.openTaskDetail(task)
        );
    }

    renderTaskDetail(container: HTMLElement): void {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace || !this.currentProject || !this.currentTask) return;

        this.detailRenderer.renderTaskDetail(
            container,
            workspace,
            this.currentProject,
            this.currentTask,
            this.editingTaskOriginal,
            this.currentProjects,
            this.currentTasks,
            this.callbacks.buildDetailCallbacks(),
            () => this.saveTaskDetail()
        );
    }

    // --- Navigation entry points ---

    async openProjectsPage(): Promise<boolean> {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace?.id) {
            new Notice('Save this workspace before managing projects');
            return false;
        }

        if (!await this.getTaskService()) {
            new Notice('Task service is not available yet');
            return false;
        }

        try {
            await this.refreshProjects();
            return true;
        } catch (error) {
            console.error('[ProjectsManagerView] Failed to load projects:', error);
            new Notice('Failed to load projects');
            return false;
        }
    }

    async openProjectDetail(project: ProjectMetadata): Promise<void> {
        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            const taskResult = await taskService.listTasks(project.id, { pageSize: 1000, includeSubtasks: true });
            this.currentProject = this.createProjectEditorState(project);
            this.currentTasks = taskResult.items;
        } catch (error) {
            console.error('[ProjectsManagerView] Failed to load project tasks:', error);
            new Notice('Failed to load project tasks');
        }
    }

    async openNewProject(): Promise<boolean> {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace?.id) {
            new Notice('Save this workspace before creating a project');
            return false;
        }

        if (!await this.getTaskService()) {
            new Notice('Task service is not available yet');
            return false;
        }

        this.currentProject = this.createProjectEditorState();
        this.currentTasks = [];
        this.editingTaskOriginal = null;
        this.currentTask = null;
        return true;
    }

    openTaskDetail(task?: TaskMetadata): void {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!this.currentProject?.id || !workspace?.id) {
            new Notice('Save the project before editing tasks');
            return;
        }

        this.editingTaskOriginal = task ?? null;
        this.currentTask = this.createTaskEditorState(task, this.currentProject.id);
    }

    // --- CRUD operations ---

    private async saveProjectDetail(): Promise<void> {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!this.currentProject || !workspace?.id) return;

        if (!this.currentProject.name.trim()) {
            new Notice('Project name is required');
            return;
        }

        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            if (this.currentProject.id) {
                await taskService.updateProject(this.currentProject.id, {
                    name: this.currentProject.name.trim(),
                    description: this.currentProject.description.trim() || undefined,
                    status: this.currentProject.status
                });
            } else {
                const projectId = await taskService.createProject(workspace.id, {
                    name: this.currentProject.name.trim(),
                    description: this.currentProject.description.trim() || undefined
                });
                this.currentProject.id = projectId;
            }

            await this.refreshProjects();
            const savedProject = this.currentProjects.find(project => project.id === this.currentProject?.id);
            if (savedProject) {
                await this.openProjectDetail(savedProject);
                this.callbacks.onRender();
            } else {
                this.callbacks.onRender();
            }
            new Notice('Project saved');
        } catch (error) {
            console.error('[ProjectsManagerView] Failed to save project:', error);
            new Notice('Failed to save project');
        }
    }

    private async saveTaskDetail(): Promise<void> {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!this.currentTask || !workspace?.id || !this.currentProject?.id) return;

        if (!this.currentTask.title.trim()) {
            new Notice('Task title is required');
            return;
        }

        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        const normalizedTags = this.currentTask.tags
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);

        try {
            if (this.currentTask.id) {
                await taskService.updateTask(this.currentTask.id, {
                    title: this.currentTask.title.trim(),
                    description: this.currentTask.description.trim() || undefined,
                    status: this.currentTask.status,
                    priority: this.currentTask.priority,
                    dueDate: this.fromDateInputValue(this.currentTask.dueDate),
                    assignee: this.currentTask.assignee.trim() || undefined,
                    tags: normalizedTags.length > 0 ? normalizedTags : undefined
                });

                const projectChanged = this.editingTaskOriginal && this.currentTask.projectId !== this.editingTaskOriginal.projectId;
                const parentChanged = this.editingTaskOriginal && (this.currentTask.parentTaskId || '') !== (this.editingTaskOriginal.parentTaskId || '');
                if (projectChanged || parentChanged) {
                    await taskService.moveTask(this.currentTask.id, {
                        projectId: projectChanged ? this.currentTask.projectId : undefined,
                        parentTaskId: parentChanged
                            ? (this.currentTask.parentTaskId || null)
                            : undefined
                    });
                }
            } else {
                await taskService.createTask(this.currentTask.projectId, {
                    title: this.currentTask.title.trim(),
                    description: this.currentTask.description.trim() || undefined,
                    priority: this.currentTask.priority,
                    dueDate: this.fromDateInputValue(this.currentTask.dueDate),
                    assignee: this.currentTask.assignee.trim() || undefined,
                    tags: normalizedTags.length > 0 ? normalizedTags : undefined,
                    parentTaskId: this.currentTask.parentTaskId || undefined
                });
            }

            await this.refreshProjects();
            const activeProject = this.currentProjects.find(project => project.id === this.currentTask?.projectId)
                || this.currentProjects.find(project => project.id === this.currentProject?.id);
            if (activeProject) {
                await this.openProjectDetail(activeProject);
            }
            this.callbacks.onRender();
            new Notice('Task saved');
        } catch (error) {
            console.error('[ProjectsManagerView] Failed to save task:', error);
            new Notice('Failed to save task');
        }
    }

    // --- Data access (for WorkspacesTab to read current view state) ---

    getCurrentProject(): ProjectEditorState | null {
        return this.currentProject;
    }

    getCurrentTask(): TaskEditorState | null {
        return this.currentTask;
    }

    // --- Service access ---

    async getTaskService(): Promise<TaskService | null> {
        if (this.taskService !== undefined) return this.taskService;

        if (!this.serviceManager) {
            this.taskService = null;
            return null;
        }

        try {
            const adapter = await this.serviceManager.getService<HybridStorageAdapter>('hybridStorageAdapter');
            const { TaskBoardEvents } = await import('../../services/task/TaskBoardEvents');
            this.taskService = new TaskService(
                adapter.projects,
                adapter.tasks,
                new DAGService(),
                undefined,
                TaskBoardEvents,
                async () => typeof adapter.waitForQueryReady === 'function' ? adapter.waitForQueryReady() : adapter.isReady()
            );
            return this.taskService;
        } catch {
            this.taskService = null;
            return null;
        }
    }

    async refreshProjects(): Promise<void> {
        const workspace = this.callbacks.getCurrentWorkspace();
        if (!workspace?.id) return;

        const taskService = await this.getTaskService();
        if (!taskService) return;

        const projects = await taskService.listProjects(workspace.id, { pageSize: 1000 });
        this.currentProjects = projects.items;

        const tasksByProject = await Promise.all(
            this.currentProjects.map(project => taskService.listTasks(project.id, { pageSize: 1000, includeSubtasks: true }))
        );
        this.currentTasks = tasksByProject.flatMap(result => result.items);
    }

    // --- State reset ---

    resetState(): void {
        this.currentProject = null;
        this.currentTask = null;
        this.currentProjects = [];
        this.currentTasks = [];
        this.editingTaskOriginal = null;
    }

    // --- Helpers ---

    private createProjectEditorState(project?: ProjectMetadata): ProjectEditorState {
        const workspace = this.callbacks.getCurrentWorkspace();
        return {
            id: project?.id,
            workspaceId: project?.workspaceId || workspace?.id || '',
            name: project?.name || '',
            description: project?.description || '',
            status: project?.status || 'active'
        };
    }

    private createTaskEditorState(task: TaskMetadata | undefined, projectId: string): TaskEditorState {
        return {
            id: task?.id,
            projectId: task?.projectId || projectId,
            title: task?.title || '',
            description: task?.description || '',
            status: task?.status || 'todo',
            priority: task?.priority || 'medium',
            dueDate: this.toDateInputValue(task?.dueDate),
            assignee: task?.assignee || '',
            tags: task?.tags?.join(', ') || '',
            parentTaskId: task?.parentTaskId || ''
        };
    }

    private toDateInputValue(timestamp?: number): string {
        if (!timestamp) return '';
        return new Date(timestamp).toISOString().slice(0, 10);
    }

    private fromDateInputValue(value: string): number | undefined {
        if (!value) return undefined;
        const timestamp = new Date(`${value}T00:00:00`).getTime();
        return Number.isNaN(timestamp) ? undefined : timestamp;
    }
}
