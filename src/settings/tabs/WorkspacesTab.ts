/**
 * WorkspacesTab - Workspace list and detail view (coordinator)
 *
 * Owns state and navigation. Delegates rendering to:
 * - WorkspaceListRenderer (list view)
 * - WorkspaceDetailRenderer (detail, project, task views)
 * - WorkflowEditorRenderer (workflow editor)
 * - FilePickerRenderer (file picker)
 */

import { App, Notice, Component } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { BreadcrumbNav, BreadcrumbNavItem } from '../components/BreadcrumbNav';
import { WorkflowEditorRenderer, Workflow } from '../../components/workspace/WorkflowEditorRenderer';
import { FilePickerRenderer } from '../../components/workspace/FilePickerRenderer';
import { WorkspaceListRenderer } from '../../components/workspace/WorkspaceListRenderer';
import { WorkspaceDetailRenderer, DetailCallbacks } from '../../components/workspace/WorkspaceDetailRenderer';
import { ProjectWorkspace } from '../../database/workspace-types';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { v4 as uuidv4 } from '../../utils/uuid';
import type { ServiceManager } from '../../core/ServiceManager';
import type { WorkflowRunService } from '../../services/workflows/WorkflowRunService';
import { TaskService } from '../../agents/taskManager/services/TaskService';
import { DAGService } from '../../agents/taskManager/services/DAGService';
import type { HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskPriority, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';

export interface WorkspacesTabServices {
    app: App;
    workspaceService?: WorkspaceService;
    customPromptStorage?: CustomPromptStorageService;
    prefetchedWorkspaces?: ProjectWorkspace[] | null;
    serviceManager?: ServiceManager;
    component?: Component;
}

type WorkspacesView = 'list' | 'detail' | 'workflow' | 'filepicker' | 'projects' | 'project-detail' | 'task-detail';

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

export class WorkspacesTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private services: WorkspacesTabServices;
    private workspaces: ProjectWorkspace[] = [];
    private currentWorkspace: Partial<ProjectWorkspace> | null = null;
    private currentWorkflowIndex: number = -1;
    private currentFileIndex: number = -1;
    private currentView: WorkspacesView = 'list';
    private currentProjects: ProjectMetadata[] = [];
    private currentProject: ProjectEditorState | null = null;
    private currentTasks: TaskMetadata[] = [];
    private currentTask: TaskEditorState | null = null;
    private editingTaskOriginal: TaskMetadata | null = null;
    private taskService: TaskService | null | undefined;

    // Renderers
    private listRenderer: WorkspaceListRenderer;
    private detailRenderer: WorkspaceDetailRenderer;
    private workflowRenderer?: WorkflowEditorRenderer;
    private filePickerRenderer?: FilePickerRenderer;

    // Auto-save debounce
    private saveTimeout?: ReturnType<typeof setTimeout>;

    // Loading state
    private isLoading: boolean = true;

    constructor(
        container: HTMLElement,
        router: SettingsRouter,
        services: WorkspacesTabServices
    ) {
        this.container = container;
        this.router = router;
        this.services = services;
        this.listRenderer = new WorkspaceListRenderer();
        this.detailRenderer = new WorkspaceDetailRenderer(services.component);

        if (Array.isArray(services.prefetchedWorkspaces)) {
            this.workspaces = services.prefetchedWorkspaces!;
            this.isLoading = false;
            this.render();
        } else {
            this.render();
            this.loadWorkspaces().then(() => {
                this.isLoading = false;
                this.render();
            });
        }
    }

    private async loadWorkspaces(): Promise<void> {
        let workspaceService = this.services.workspaceService;

        if (this.services.serviceManager) {
            const timeout = <T>(ms: number) => new Promise<T | undefined>(r => setTimeout(() => r(undefined), ms));
            try {
                const [service] = await Promise.all([
                    Promise.race([
                        this.services.serviceManager.getService<WorkspaceService>('workspaceService'),
                        timeout<WorkspaceService>(10000)
                    ]),
                    Promise.race([
                        this.services.serviceManager.getService('hybridStorageAdapter'),
                        timeout(10000)
                    ])
                ]);
                if (service) {
                    workspaceService = service as WorkspaceService;
                    this.services.workspaceService = workspaceService;
                }
            } catch (e) {
                // Service unavailable
            }
        }

        if (!workspaceService) return;

        try {
            this.workspaces = await workspaceService.getAllWorkspaces();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to load workspaces:', error);
            this.workspaces = [];
        }
    }

    render(): void {
        this.container.empty();

        if (this.currentView === 'workflow') {
            this.renderWorkflowEditor();
            return;
        }

        if (this.currentView === 'filepicker') {
            this.renderFilePicker();
            return;
        }

        if (this.currentView === 'projects') {
            this.detailRenderer.renderProjects(
                this.container,
                this.currentWorkspace!,
                this.currentProjects,
                this.currentTasks,
                this.buildDetailCallbacks()
            );
            return;
        }

        if (this.currentView === 'project-detail') {
            this.detailRenderer.renderProjectDetail(
                this.container,
                this.currentWorkspace!,
                this.currentProject!,
                this.currentTasks,
                this.currentProjects,
                this.buildDetailCallbacks(),
                () => this.saveProjectDetail(),
                (task?) => this.openTaskDetail(task)
            );
            return;
        }

        if (this.currentView === 'task-detail') {
            this.detailRenderer.renderTaskDetail(
                this.container,
                this.currentWorkspace!,
                this.currentProject!,
                this.currentTask!,
                this.editingTaskOriginal,
                this.currentProjects,
                this.currentTasks,
                this.buildDetailCallbacks(),
                () => this.saveTaskDetail()
            );
            return;
        }

        const state = this.router.getState();

        if (state.view === 'detail' && state.detailId) {
            this.currentView = 'detail';
            const workspace = this.workspaces.find(w => w.id === state.detailId);
            if (workspace) {
                this.currentWorkspace = { ...workspace };
                this.detailRenderer.renderDetail(
                    this.container,
                    this.currentWorkspace,
                    this.workspaces,
                    this.buildDetailCallbacks()
                );
                return;
            }
        }

        // Default to list view
        this.currentView = 'list';
        this.currentProject = null;
        this.currentTask = null;
        this.currentProjects = [];
        this.currentTasks = [];
        this.editingTaskOriginal = null;

        this.listRenderer.render(
            this.container,
            this.workspaces,
            this.isLoading,
            !!this.services.workspaceService,
            {
                onCreateNew: () => this.createNewWorkspace(),
                onEdit: (id) => this.router.showDetail(id),
                onToggle: async (id, enabled) => {
                    const workspace = this.workspaces.find(w => w.id === id);
                    if (workspace && this.services.workspaceService) {
                        await this.services.workspaceService.updateWorkspace(id, { isActive: enabled });
                        workspace.isActive = enabled;
                    }
                },
                onDelete: async (id) => {
                    if (this.services.workspaceService) {
                        await this.services.workspaceService.deleteWorkspace(id);
                        this.workspaces = this.workspaces.filter(w => w.id !== id);
                        this.listRenderer.updateItems(this.workspaces);
                    }
                }
            }
        );
    }

    private buildDetailCallbacks(): DetailCallbacks {
        return {
            onNavigateList: () => this.showWorkspaceList(),
            onNavigateDetail: () => this.showWorkspaceDetail(),
            onNavigateProjects: () => this.showProjectsPage(),
            onNavigateProjectDetail: () => this.showProjectPage(),
            onSaveWorkspace: () => this.saveCurrentWorkspace(),
            onDeleteWorkspace: () => this.deleteCurrentWorkspace(),
            onOpenWorkflowEditor: (index) => this.openWorkflowEditor(index),
            onRunWorkflow: (index) => { void this.runWorkflow(index); },
            onOpenFilePicker: (index) => this.openFilePicker(index),
            onRefreshDetail: () => this.refreshDetail(),
            getAvailableAgents: () => this.getAvailableAgents(),
            getTaskService: () => this.getTaskService() as any,
            onRefreshProjects: () => this.refreshProjects(),
            onOpenProjectDetail: (project) => { void this.openProjectDetail(project); },
            safeRegisterDomEvent: (el, eventName, handler) => this.safeRegisterDomEvent(el, eventName, handler)
        };
    }

    // --- Navigation ---

    private showWorkspaceList(): void {
        this.currentView = 'list';
        this.router.back();
    }

    private showWorkspaceDetail(): void {
        if (!this.currentWorkspace?.id) {
            this.showWorkspaceList();
            return;
        }
        this.currentView = 'detail';
        this.router.showDetail(this.currentWorkspace.id);
    }

    private showProjectsPage(): void {
        this.currentView = 'projects';
        this.render();
    }

    private showProjectPage(): void {
        this.currentView = 'project-detail';
        this.render();
    }

    // --- Workspace CRUD ---

    private createNewWorkspace(): void {
        this.currentWorkspace = {
            id: uuidv4(),
            name: '',
            description: '',
            rootFolder: '/',
            isActive: true,
            context: {
                purpose: '',
                workflows: [],
                keyFiles: [],
                preferences: ''
            },
            created: Date.now(),
            lastAccessed: Date.now()
        };
        this.currentView = 'detail';
        this.render();
    }

    private async saveCurrentWorkspace(): Promise<ProjectWorkspace | null> {
        if (!this.currentWorkspace || !this.services.workspaceService) return null;

        try {
            const existingIndex = this.workspaces.findIndex(w => w.id === this.currentWorkspace?.id);

            if (existingIndex >= 0) {
                await this.services.workspaceService.updateWorkspace(
                    this.currentWorkspace.id!,
                    this.currentWorkspace
                );
                this.workspaces[existingIndex] = this.currentWorkspace as ProjectWorkspace;
                return this.currentWorkspace as ProjectWorkspace;
            } else {
                const created = await this.services.workspaceService.createWorkspace(this.currentWorkspace);
                this.workspaces.push(created);
                this.currentWorkspace = created;
                return created;
            }
        } catch (error) {
            console.error('[WorkspacesTab] Failed to save workspace:', error);
            new Notice('Failed to save workspace');
            return null;
        }
    }

    private async deleteCurrentWorkspace(): Promise<void> {
        if (!this.currentWorkspace?.id || !this.services.workspaceService) return;

        const confirmed = confirm(`Delete workspace "${this.currentWorkspace.name}"? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await this.services.workspaceService.deleteWorkspace(this.currentWorkspace.id);
            this.workspaces = this.workspaces.filter(w => w.id !== this.currentWorkspace?.id);
            this.currentWorkspace = null;
            this.router.back();
            new Notice('Workspace deleted');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to delete workspace:', error);
            new Notice('Failed to delete workspace');
        }
    }

    // --- Projects ---

    private async openProjectsPage(): Promise<void> {
        if (!this.currentWorkspace?.id) {
            new Notice('Save this workspace before managing projects');
            return;
        }

        if (!await this.getTaskService()) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await this.refreshProjects();
            this.currentView = 'projects';
            this.render();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to load projects:', error);
            new Notice('Failed to load projects');
        }
    }

    private async openProjectDetail(project: ProjectMetadata): Promise<void> {
        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            const taskResult = await taskService.listTasks(project.id, { pageSize: 1000, includeSubtasks: true });
            this.currentProject = this.createProjectEditorState(project);
            this.currentTasks = taskResult.items;
            this.currentView = 'project-detail';
            this.render();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to load project tasks:', error);
            new Notice('Failed to load project tasks');
        }
    }

    private async saveProjectDetail(): Promise<void> {
        if (!this.currentProject || !this.currentWorkspace?.id) return;

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
                const projectId = await taskService.createProject(this.currentWorkspace.id, {
                    name: this.currentProject.name.trim(),
                    description: this.currentProject.description.trim() || undefined
                });
                this.currentProject.id = projectId;
            }

            await this.refreshProjects();
            const savedProject = this.currentProjects.find(project => project.id === this.currentProject?.id);
            if (savedProject) {
                await this.openProjectDetail(savedProject);
            } else {
                this.currentView = 'projects';
                this.render();
            }
            new Notice('Project saved');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to save project:', error);
            new Notice('Failed to save project');
        }
    }

    // --- Tasks ---

    private openTaskDetail(task?: TaskMetadata): void {
        if (!this.currentProject?.id || !this.currentWorkspace?.id) {
            new Notice('Save the project before editing tasks');
            return;
        }

        this.editingTaskOriginal = task ?? null;
        this.currentTask = this.createTaskEditorState(task, this.currentProject.id);
        this.currentView = 'task-detail';
        this.render();
    }

    private async saveTaskDetail(): Promise<void> {
        if (!this.currentTask || !this.currentWorkspace?.id || !this.currentProject?.id) return;

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
            new Notice('Task saved');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to save task:', error);
            new Notice('Failed to save task');
        }
    }

    // --- Workflow and file picker (already delegated to existing renderers) ---

    private renderWorkflowEditor(): void {
        this.container.empty();

        if (!this.currentWorkspace || !this.currentWorkspace.context) {
            this.currentView = 'detail';
            this.render();
            return;
        }

        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => this.showWorkspaceList() },
            { label: this.currentWorkspace.name || 'Workspace', onClick: () => this.showWorkspaceDetail() },
            { label: 'Workflow' }
        ]);

        const contentContainer = this.container.createDiv('nexus-settings-page-content');

        const workflows = this.currentWorkspace.context.workflows || [];
        const isNew = this.currentWorkflowIndex >= workflows.length || this.currentWorkflowIndex < 0;
        const workflow: Workflow = isNew
            ? { id: '', name: '', when: '', steps: '' }
            : workflows[this.currentWorkflowIndex];

        this.workflowRenderer = new WorkflowEditorRenderer(
            this.getAvailableAgents(),
            (savedWorkflow) => { void this.saveWorkflow(savedWorkflow); },
            () => {
                this.currentView = 'detail';
                this.render();
            },
            async (workflowToRun) => { await this.runWorkflowFromEditor(workflowToRun); }
        );

        this.workflowRenderer.render(contentContainer, workflow, isNew, { showBackButton: false });
    }

    private renderFilePicker(): void {
        this.container.empty();

        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => this.showWorkspaceList() },
            { label: this.currentWorkspace?.name || 'Workspace', onClick: () => this.showWorkspaceDetail() },
            { label: 'Key Files' }
        ]);

        const contentContainer = this.container.createDiv('nexus-settings-page-content');

        const currentPath = this.currentWorkspace?.context?.keyFiles?.[this.currentFileIndex] || '';
        const workspaceRoot = this.currentWorkspace?.rootFolder || '/';

        this.filePickerRenderer = new FilePickerRenderer(
            this.services.app,
            (path) => {
                if (this.currentWorkspace?.context?.keyFiles) {
                    this.currentWorkspace.context.keyFiles[this.currentFileIndex] = path;
                    this.debouncedSave();
                }
                this.currentView = 'detail';
                this.render();
            },
            () => {
                this.currentView = 'detail';
                this.render();
            },
            currentPath,
            workspaceRoot,
            undefined,
            this.services.component,
            false
        );

        this.filePickerRenderer.render(contentContainer);
    }

    private openWorkflowEditor(index?: number): void {
        this.currentWorkflowIndex = index ?? -1;
        this.currentView = 'workflow';
        this.renderWorkflowEditor();
    }

    private openFilePicker(index: number): void {
        this.currentFileIndex = index;
        this.currentView = 'filepicker';
        this.renderFilePicker();
    }

    // --- Workflow CRUD ---

    private async saveWorkflow(workflow: Workflow, options?: {
        returnToDetail?: boolean;
        runAfterSave?: boolean;
    }): Promise<void> {
        const persistedWorkflow = await this.persistWorkflow(workflow);
        if (!persistedWorkflow) return;

        if (options?.runAfterSave) {
            try {
                await this.executeWorkflow(persistedWorkflow.id);
                new Notice('Workflow run started');
            } catch (error) {
                console.error('[WorkspacesTab] Failed to run workflow:', error);
                new Notice('Failed to run workflow');
            }
        }

        if (options?.returnToDetail === false) {
            this.currentView = 'workflow';
            this.renderWorkflowEditor();
            return;
        }

        this.currentView = 'detail';
        this.render();
        new Notice('Workflow saved');
    }

    private async runWorkflow(index: number): Promise<void> {
        const workflow = this.currentWorkspace?.context?.workflows?.[index];
        if (!workflow?.id) {
            new Notice('Save this workflow before running it');
            return;
        }

        const savedWorkspace = await this.saveCurrentWorkspace();
        if (!savedWorkspace) return;

        this.currentWorkspace = { ...savedWorkspace };

        try {
            await this.executeWorkflow(workflow.id);
            new Notice('Workflow run started');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to run workflow:', error);
            new Notice('Failed to run workflow');
        }
    }

    private async runWorkflowFromEditor(workflow: Workflow): Promise<void> {
        await this.saveWorkflow(workflow, { runAfterSave: true, returnToDetail: false });
    }

    private async persistWorkflow(workflow: Workflow): Promise<Workflow | null> {
        if (!this.currentWorkspace) return null;

        if (!this.currentWorkspace.context) {
            this.currentWorkspace.context = { purpose: '', workflows: [], keyFiles: [], preferences: '' };
        }

        if (!this.currentWorkspace.context.workflows) {
            this.currentWorkspace.context.workflows = [];
        }

        const normalizedWorkflow: Workflow = {
            ...workflow,
            id: workflow.id || uuidv4(),
            promptName: workflow.promptId
                ? this.getAvailableAgents().find(prompt => prompt.id === workflow.promptId)?.name || workflow.promptName
                : undefined
        };

        const existingIndex = this.currentWorkspace.context.workflows.findIndex(item => item.id === normalizedWorkflow.id);

        if (existingIndex >= 0) {
            this.currentWorkspace.context.workflows[existingIndex] = normalizedWorkflow;
            this.currentWorkflowIndex = existingIndex;
        } else if (this.currentWorkflowIndex >= 0 && this.currentWorkflowIndex < this.currentWorkspace.context.workflows.length) {
            this.currentWorkspace.context.workflows[this.currentWorkflowIndex] = normalizedWorkflow;
        } else {
            this.currentWorkspace.context.workflows.push(normalizedWorkflow);
            this.currentWorkflowIndex = this.currentWorkspace.context.workflows.length - 1;
        }

        const savedWorkspace = await this.saveCurrentWorkspace();
        if (!savedWorkspace) return null;

        this.currentWorkspace = { ...savedWorkspace };
        const savedWorkflow = savedWorkspace.context?.workflows?.find(item => item.id === normalizedWorkflow.id);
        if (!savedWorkflow) return normalizedWorkflow;

        this.currentWorkflowIndex = savedWorkspace.context?.workflows?.findIndex(item => item.id === normalizedWorkflow.id) ?? this.currentWorkflowIndex;
        return savedWorkflow;
    }

    private async executeWorkflow(workflowId: string): Promise<void> {
        if (!this.currentWorkspace?.id) {
            throw new Error('Workspace must be saved before running a workflow');
        }

        const workflowRunService = await this.getWorkflowRunService();
        if (!workflowRunService) {
            throw new Error('Workflow run service is not available');
        }

        await workflowRunService.start({
            workspaceId: this.currentWorkspace.id,
            workflowId,
            runTrigger: 'manual',
            scheduledFor: Date.now(),
            openInChat: true
        });
    }

    // --- Helper methods ---

    private getAvailableAgents(): CustomPrompt[] {
        if (!this.services.customPromptStorage) return [];
        return this.services.customPromptStorage.getAllPrompts();
    }

    private createProjectEditorState(project?: ProjectMetadata): ProjectEditorState {
        return {
            id: project?.id,
            workspaceId: project?.workspaceId || this.currentWorkspace?.id || '',
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

    private renderBreadcrumbs(items: BreadcrumbNavItem[]): void {
        new BreadcrumbNav(this.container, items, this.services.component);
    }

    private refreshDetail(): void {
        if (this.currentView === 'detail') {
            this.render();
        }
    }

    private safeRegisterDomEvent<K extends keyof HTMLElementEventMap>(
        element: HTMLElement,
        eventName: K,
        handler: (event: HTMLElementEventMap[K]) => void
    ): void {
        if (this.services.component) {
            this.services.component.registerDomEvent(element, eventName, handler);
        } else {
            element.addEventListener(eventName, handler as EventListener);
        }
    }

    private async refreshProjects(): Promise<void> {
        if (!this.currentWorkspace?.id) return;

        const taskService = await this.getTaskService();
        if (!taskService) return;

        const projects = await taskService.listProjects(this.currentWorkspace.id, { pageSize: 1000 });
        this.currentProjects = projects.items;

        const tasksByProject = await Promise.all(
            this.currentProjects.map(project => taskService.listTasks(project.id, { pageSize: 1000, includeSubtasks: true }))
        );
        this.currentTasks = tasksByProject.flatMap(result => result.items);
    }

    private async getTaskService(): Promise<TaskService | null> {
        if (this.taskService !== undefined) return this.taskService;

        if (!this.services.serviceManager) {
            this.taskService = null;
            return null;
        }

        try {
            const adapter = await this.services.serviceManager.getService<HybridStorageAdapter>('hybridStorageAdapter');
            this.taskService = new TaskService(adapter.projects, adapter.tasks, new DAGService());
            return this.taskService;
        } catch {
            this.taskService = null;
            return null;
        }
    }

    private async getWorkflowRunService(): Promise<WorkflowRunService | null> {
        if (!this.services.serviceManager) return null;

        try {
            return await this.services.serviceManager.getService<WorkflowRunService>('workflowRunService');
        } catch {
            return null;
        }
    }

    private debouncedSave(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => { this.saveCurrentWorkspace(); }, 500);
    }

    destroy(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.detailRenderer.destroyForm();
    }
}
