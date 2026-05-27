/**
 * WorkspaceDetailRenderer — Renders workspace detail, project, and task views.
 * Extracted from WorkspacesTab to keep the tab under 600 lines.
 */

import { App, ButtonComponent, Component, DropdownComponent, Notice, setIcon, TextAreaComponent, TextComponent, ToggleComponent } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { ConfirmModal } from '../../settings/components/ConfirmModal';
import { BreadcrumbNav, BreadcrumbNavItem } from '../../settings/components/BreadcrumbNav';
import { WorkspaceFormRenderer } from './WorkspaceFormRenderer';
import { ProjectDetailRenderer, ProjectDetailCallbacks } from './ProjectDetailRenderer';
import { ProjectWorkspace } from '../../database/workspace-types';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import type { CreateTaskData, TaskListOptions, UpdateTaskData } from '../../agents/taskManager/types';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskPriority, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';
import type { PaginatedResult } from '../../types/pagination/PaginationTypes';
import { StatesSectionRenderer, StatesSectionService } from './StatesSectionRenderer';

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

type WorkspaceTaskMoveTarget = {
    projectId?: string;
    parentTaskId?: string | null;
};

interface WorkspaceDetailTaskService {
    updateTask: (taskId: string, data: UpdateTaskData) => Promise<void>;
    createTask: (projectId: string, data: CreateTaskData) => Promise<string>;
    moveTask: (taskId: string, target: WorkspaceTaskMoveTarget) => Promise<void>;
    deleteProject: (projectId: string) => Promise<void>;
    deleteTask: (taskId: string) => Promise<void>;
    listTasks: (projectId: string, options?: TaskListOptions) => Promise<PaginatedResult<TaskMetadata>>;
}

export interface DetailCallbacks {
    onNavigateList: () => void;
    onNavigateDetail: () => void;
    onNavigateProjects: () => void;
    onNavigateProjectDetail: () => void;
    onSaveWorkspace: () => Promise<ProjectWorkspace | null>;
    onDeleteWorkspace: () => Promise<void>;
    onOpenWorkflowEditor: (index?: number) => void;
    onRunWorkflow: (index: number) => void;
    onOpenFilePicker: (index: number) => void;
    onRefreshDetail: () => void;
    getAvailableAgents: () => CustomPrompt[];
    getTaskService: () => Promise<WorkspaceDetailTaskService | null>;
    onRefreshProjects: () => Promise<void>;
    onOpenProjectDetail: (project: ProjectMetadata) => void;
    onToggleProjectArchive: (project: ProjectMetadata) => Promise<void>;
    safeRegisterDomEvent: <K extends keyof HTMLElementEventMap>(el: HTMLElement, eventName: K, handler: (event: HTMLElementEventMap[K]) => void) => void;
    /**
     * Resolves the service used by the States section. Returns null when the
     * service is unavailable (e.g., MemoryService not yet initialized) so the
     * section can render a placeholder.
     */
    getStatesService: () => Promise<StatesSectionService | null>;
    /** Provides the Obsidian App instance for the States section's modals. */
    getApp: () => App;
}

export class WorkspaceDetailRenderer {
    private formRenderer?: WorkspaceFormRenderer;
    private statesRenderer?: StatesSectionRenderer;
    private projectDetailRenderer: ProjectDetailRenderer | null = null;
    private component: Component;
    private showArchivedProjects = false;

    constructor(component: Component) {
        this.component = component;
    }

    private confirmDangerousAction(app: App, message: string): Promise<boolean> {
        return ConfirmModal.confirm(app, {
            variant: 'delete',
            title: 'Confirm delete',
            body: message
        });
    }

    renderDetail(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        workspaces: ProjectWorkspace[],
        callbacks: DetailCallbacks
    ): void {
        if (!workspace) {
            callbacks.onNavigateList();
            return;
        }

        this.renderBreadcrumbs(container, [
            { label: 'Workspaces', onClick: () => {
                void callbacks.onSaveWorkspace();
                callbacks.onNavigateList();
            } },
            { label: workspace.name || 'Workspace' }
        ]);

        container.createEl('h3', {
            text: workspace.name || 'New Workspace',
            cls: 'nexus-detail-title'
        });

        const agents = callbacks.getAvailableAgents();
        const formContainer = container.createDiv('workspace-form-container');

        this.formRenderer = new WorkspaceFormRenderer(
            workspace,
            agents,
            (index) => callbacks.onOpenWorkflowEditor(index),
            (index) => callbacks.onRunWorkflow(index),
            (index) => callbacks.onOpenFilePicker(index),
            () => callbacks.onRefreshDetail(),
            this.component,
            callbacks.getApp()
        );

        this.formRenderer.render(formContainer);

        this.renderProjectsSection(container, workspace, callbacks);
        this.renderStatesSection(container, workspace, callbacks);

        const actions = container.createDiv('nexus-form-actions');

        new ButtonComponent(actions)
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
                void callbacks.onSaveWorkspace().then(savedWorkspace => {
                    if (savedWorkspace) {
                        new Notice('Workspace saved');
                        callbacks.onNavigateList();
                    }
                }).catch(error => {
                    console.error('[WorkspaceDetailRenderer] Failed to save workspace:', error);
                    new Notice('Failed to save workspace');
                });
            });

        if (workspace.id && workspaces.some(w => w.id === workspace.id)) {
            new ButtonComponent(actions)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => void callbacks.onDeleteWorkspace());
        }
    }

    private renderProjectsSection(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        callbacks: DetailCallbacks
    ): void {
        new BoxedSection(container, {
            title: 'Projects',
            unbounded: true,
            body: (body) => {
                if (!workspace.id) {
                    body.createEl('p', {
                        text: 'Save this workspace before managing projects and tasks.',
                        cls: 'nexus-form-hint'
                    });
                    return;
                }

                body.createEl('p', {
                    text: 'Manage workspace projects and project tasks using the same settings navigation pattern as workflows.',
                    cls: 'nexus-form-hint'
                });

                new ButtonComponent(body)
                    .setButtonText('Manage projects')
                    .onClick(() => {
                        callbacks.onNavigateProjects();
                    });
            }
        }, this.component);
    }

    private renderStatesSection(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        callbacks: DetailCallbacks
    ): void {
        const sectionHost = container.createDiv();

        if (!workspace.id) {
            new BoxedSection(sectionHost, {
                title: 'States',
                unbounded: true,
                body: (body) => {
                    body.createEl('p', {
                        text: 'Save this workspace before managing states.',
                        cls: 'nexus-form-hint'
                    });
                }
            }, this.component);
            return;
        }

        const workspaceId = workspace.id;

        // Render an initial placeholder so the section is visible while the
        // service resolves; the StatesSectionRenderer will replace it when
        // the service is ready (or render an error if not).
        new BoxedSection(sectionHost, {
            title: 'States',
            unbounded: true,
            body: (body) => {
                body.createEl('p', {
                    text: 'Loading states section...',
                    cls: 'nexus-loading-message'
                });
            }
        }, this.component);

        void callbacks.getStatesService().then((service) => {
            sectionHost.empty();
            if (!service) {
                new BoxedSection(sectionHost, {
                    title: 'States',
                    unbounded: true,
                    body: (body) => {
                        body.createEl('p', {
                            text: 'States service is unavailable.',
                            cls: 'nexus-form-hint'
                        });
                    }
                }, this.component);
                return;
            }
            this.statesRenderer = new StatesSectionRenderer(callbacks.getApp(), service, this.component);
            this.statesRenderer.render(sectionHost, workspaceId);
        }).catch((error) => {
            console.error('[WorkspaceDetailRenderer] Failed to resolve states service:', error);
            sectionHost.empty();
            new BoxedSection(sectionHost, {
                title: 'States',
                unbounded: true,
                body: (body) => {
                    body.createEl('p', {
                        text: 'Failed to load states section.',
                        cls: 'nexus-form-hint nexus-states-error'
                    });
                }
            }, this.component);
        });
    }

    renderProjects(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        projects: ProjectMetadata[],
        tasks: TaskMetadata[],
        callbacks: DetailCallbacks
    ): void {
        if (!workspace.id) {
            callbacks.onNavigateDetail();
            return;
        }

        this.renderBreadcrumbs(container, [
            { label: 'Workspaces', onClick: () => callbacks.onNavigateList() },
            { label: workspace.name || 'Workspace', onClick: () => callbacks.onNavigateDetail() },
            { label: 'Projects' }
        ]);

        container.createEl('h3', {
            text: 'Projects',
            cls: 'nexus-detail-title'
        });

        new BoxedSection(container, {
            title: 'Projects',
            unbounded: true,
            actionLabel: '+ New project',
            onAction: () => callbacks.onNavigateProjectDetail(),
            toolbar: (toolbar) => {
                const archivedLabel = toolbar.createDiv('nexus-projects-archived-toggle');
                archivedLabel.createSpan({ text: 'Show archived', cls: 'nexus-section-toolbar-label' });
                new ToggleComponent(archivedLabel)
                    .setValue(this.showArchivedProjects)
                    .onChange((value) => {
                        this.showArchivedProjects = value;
                        callbacks.onRefreshDetail();
                    });
            },
            body: (body) => {
                this.renderProjectGroups(body, projects, tasks, callbacks);
            }
        }, this.component);
    }

    private renderProjectGroups(
        body: HTMLElement,
        projects: ProjectMetadata[],
        tasks: TaskMetadata[],
        callbacks: DetailCallbacks
    ): void {
        const visible = this.showArchivedProjects
            ? projects
            : projects.filter(p => p.status !== 'archived');

        if (visible.length === 0) {
            body.createEl('p', {
                text: 'No projects yet. Create one to get started.',
                cls: 'nexus-form-hint'
            });
            return;
        }

        const groups: Array<{ key: ProjectStatus; label: string }> = [
            { key: 'active',    label: 'Active' },
            { key: 'completed', label: 'Completed' },
            { key: 'archived',  label: 'Archived' }
        ];

        for (const group of groups) {
            const inGroup = visible.filter(p => p.status === group.key);
            if (inGroup.length === 0) continue;

            inGroup.sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created));

            body.createDiv({
                cls: 'ws-group-label',
                text: `${group.label} · ${inGroup.length}`
            });

            for (const project of inGroup) {
                this.renderProjectRow(body, project, tasks, callbacks);
            }
        }
    }

    private renderProjectRow(
        body: HTMLElement,
        project: ProjectMetadata,
        tasks: TaskMetadata[],
        callbacks: DetailCallbacks
    ): void {
        const row = body.createDiv({
            cls: 'setting-item is-project' + (project.status === 'archived' ? ' is-archived' : '')
        });

        const info = row.createDiv('setting-item-info');
        info.createDiv({ cls: 'setting-item-name', text: project.name });
        info.createDiv({
            cls: 'setting-item-description',
            text: this.formatProjectDescription(project, tasks)
        });

        const control = row.createDiv('setting-item-control');

        const editBtn = control.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Edit project' }
        });
        setIcon(editBtn, 'pencil');
        this.component.registerDomEvent(editBtn, 'click', () => callbacks.onOpenProjectDetail(project));

        const isArchived = project.status === 'archived';
        const archiveBtn = control.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': isArchived ? 'Restore project' : 'Archive project' }
        });
        setIcon(archiveBtn, isArchived ? 'archive-restore' : 'archive');
        this.component.registerDomEvent(archiveBtn, 'click', () => void callbacks.onToggleProjectArchive(project));

        const deleteBtn = control.createEl('button', {
            cls: 'clickable-icon mod-warning',
            attr: { 'aria-label': 'Delete project' }
        });
        setIcon(deleteBtn, 'trash');
        this.component.registerDomEvent(deleteBtn, 'click', () => void this.deleteProject(project.id, callbacks));
    }

    private formatProjectDescription(project: ProjectMetadata, tasks: TaskMetadata[]): string {
        const projectTasks = tasks.filter(task => task.projectId === project.id);
        const total = projectTasks.length;
        const open = projectTasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').length;
        const done = projectTasks.filter(task => task.status === 'done').length;
        const desc = project.description?.trim() ?? '';
        const summary = `${total} tasks · ${open} open · ${done} done`;
        return desc ? `${desc} · ${summary}` : summary;
    }

    renderProjectDetail(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        project: ProjectEditorState,
        tasks: TaskMetadata[],
        allProjects: ProjectMetadata[],
        callbacks: DetailCallbacks,
        onSaveProject: () => Promise<void>,
        onOpenTaskDetail: (task?: TaskMetadata) => void
    ): void {
        this.projectDetailRenderer ??= new ProjectDetailRenderer(callbacks.getApp(), this.component);

        const projectDetailCallbacks: ProjectDetailCallbacks = {
            getWorkspace: () => workspace,
            getProject: () => project,
            getTasks: () => tasks,
            onNavigateList: () => callbacks.onNavigateList(),
            onNavigateDetail: () => callbacks.onNavigateDetail(),
            onNavigateProjects: () => callbacks.onNavigateProjects(),
            onSaveProject,
            onDeleteProject: (projectId) => this.deleteProject(projectId, callbacks),
            onOpenTaskDetail,
            onDeleteTask: (taskId) => this.deleteTask(taskId, callbacks)
        };

        this.projectDetailRenderer.render(container, projectDetailCallbacks);
    }

    renderTaskDetail(
        container: HTMLElement,
        workspace: Partial<ProjectWorkspace>,
        project: ProjectEditorState,
        task: TaskEditorState,
        editingTaskOriginal: TaskMetadata | null,
        allProjects: ProjectMetadata[],
        allTasks: TaskMetadata[],
        callbacks: DetailCallbacks,
        onSaveTask: () => Promise<void>
    ): void {
        if (!project.id || !workspace.id || !task) {
            callbacks.onNavigateProjectDetail();
            return;
        }

        this.renderBreadcrumbs(container, [
            { label: 'Workspaces', onClick: () => callbacks.onNavigateList() },
            { label: workspace.name || 'Workspace', onClick: () => callbacks.onNavigateDetail() },
            { label: 'Projects', onClick: () => callbacks.onNavigateProjects() },
            { label: project.name || 'Project', onClick: () => callbacks.onNavigateProjectDetail() },
            { label: task.id ? (task.title || 'Task') : 'New Task' }
        ]);

        container.createEl('h3', {
            text: task.id ? 'Edit task' : 'New task',
            cls: 'nexus-detail-title'
        });

        const form = container.createDiv('nexus-workspace-form');
        const details = form.createDiv('nexus-form-section');
        details.createEl('h4', { text: 'Task details', cls: 'nexus-section-header' });

        const titleField = details.createDiv('nexus-form-field');
        titleField.createEl('label', { text: 'Title', cls: 'nexus-form-label' });
        const titleInput = new TextComponent(titleField);
        titleInput.setPlaceholder('Task title');
        titleInput.setValue(task.title ?? '');
        titleInput.onChange((value) => { task.title = value; });

        const descriptionField = details.createDiv('nexus-form-field');
        descriptionField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        const descriptionInput = new TextAreaComponent(descriptionField);
        descriptionInput.setPlaceholder('Optional task description');
        descriptionInput.setValue(task.description ?? '');
        descriptionInput.onChange((value) => { task.description = value; });
        descriptionInput.inputEl.rows = 4;

        const metaGrid = details.createDiv('nexus-task-form-grid');

        this.renderTaskDropdown(metaGrid, 'Status', task.status, [
            ['todo', 'Todo'], ['in_progress', 'In progress'],
            ['done', 'Done'], ['cancelled', 'Cancelled']
        ], (value) => { task.status = value as TaskStatus; });

        this.renderTaskDropdown(metaGrid, 'Priority', task.priority, [
            ['critical', 'Critical'], ['high', 'High'],
            ['medium', 'Medium'], ['low', 'Low']
        ], (value) => { task.priority = value as TaskPriority; });

        this.renderTaskDropdown(
            metaGrid, 'Project', task.projectId,
            allProjects.map(p => [p.id, p.name] as [string, string]),
            (value) => { task.projectId = value; },
            false
        );

        const parentOptions: Array<[string, string]> = [['', 'None']];
        allTasks
            .filter(t => t.id !== task.id)
            .forEach(t => parentOptions.push([t.id, t.title]));
        this.renderTaskDropdown(metaGrid, 'Parent Task', task.parentTaskId, parentOptions, (value) => {
            task.parentTaskId = value;
        });

        this.renderTaskTextField(metaGrid, 'Assignee', task.assignee, (value) => {
            task.assignee = value;
        }, callbacks);

        this.renderTaskTextField(metaGrid, 'Due Date', task.dueDate, (value) => {
            task.dueDate = value;
        }, callbacks, 'date');

        const tagsField = details.createDiv('nexus-form-field');
        tagsField.createEl('label', { text: 'Tags', cls: 'nexus-form-label' });
        const tagsInput = new TextComponent(tagsField);
        tagsInput.setPlaceholder('Comma-separated tags');
        tagsInput.setValue(task.tags ?? '');
        tagsInput.onChange((value) => { task.tags = value; });

        const actions = container.createDiv('nexus-form-actions');
        new ButtonComponent(actions)
            .setButtonText('Save task')
            .setCta()
            .onClick(() => void onSaveTask());

        if (task.id) {
            new ButtonComponent(actions)
                .setButtonText('Delete task')
                .setWarning()
                .onClick(() => {
                    if (task.id) {
                        void this.deleteTask(task.id, callbacks);
                    }
                });
        }
    }

    // --- Utility methods ---

    private renderBreadcrumbs(container: HTMLElement, items: BreadcrumbNavItem[]): void {
        new BreadcrumbNav(container, items, this.component);
    }

    private renderTaskDropdown(
        container: HTMLElement,
        label: string,
        value: string,
        options: Array<[string, string]>,
        onChange: (value: string) => void,
        includeEmpty = true
    ): void {
        const field = container.createDiv('nexus-form-field');
        field.createEl('label', { text: label, cls: 'nexus-form-label' });
        const dropdown = new DropdownComponent(field);
        if (includeEmpty && !options.some(([optionValue]) => optionValue === '')) {
            dropdown.addOption('', 'None');
        }
        for (const [optionValue, optionLabel] of options) {
            dropdown.addOption(optionValue, optionLabel);
        }
        dropdown.setValue(value ?? '');
        dropdown.onChange(onChange);
    }

    private renderTaskTextField(
        container: HTMLElement,
        label: string,
        value: string,
        onChange: (value: string) => void,
        callbacks: DetailCallbacks,
        type: 'text' | 'date' = 'text'
    ): void {
        const field = container.createDiv('nexus-form-field');
        field.createEl('label', { text: label, cls: 'nexus-form-label' });
        const input = field.createEl('input', {
            cls: 'nexus-form-input',
            type
        });
        input.value = value;
        callbacks.safeRegisterDomEvent(input, 'input', () => {
            onChange(input.value);
        });
    }

    private async deleteProject(projectId: string, callbacks: DetailCallbacks): Promise<void> {
        const confirmed = await this.confirmDangerousAction(callbacks.getApp(), 'Delete this project and all its tasks? This cannot be undone.');
        if (!confirmed) return;

        const taskService = await callbacks.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.deleteProject(projectId);
            await callbacks.onRefreshProjects();
            callbacks.onNavigateProjects();
            new Notice('Project deleted');
        } catch (error) {
            console.error('[WorkspaceDetailRenderer] Failed to delete project:', error);
            new Notice('Failed to delete project');
        }
    }

    private async deleteTask(taskId: string, callbacks: DetailCallbacks): Promise<void> {
        const confirmed = await this.confirmDangerousAction(callbacks.getApp(), 'Delete this task? This cannot be undone.');
        if (!confirmed) return;

        const taskService = await callbacks.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.deleteTask(taskId);
            await callbacks.onRefreshProjects();
            callbacks.onNavigateProjectDetail();
        } catch (error) {
            console.error('[WorkspaceDetailRenderer] Failed to delete task:', error);
            new Notice('Failed to delete task');
        }
    }

    destroyForm(): void {
        this.formRenderer?.destroy();
    }
}
