/**
 * WorkspaceDetailRenderer — Renders workspace detail, project, and task views.
 * Extracted from WorkspacesTab to keep the tab under 600 lines.
 */

import { ButtonComponent, Component, DropdownComponent, Notice, TextAreaComponent, TextComponent } from 'obsidian';
import { BreadcrumbNav, BreadcrumbNavItem } from '../../settings/components/BreadcrumbNav';
import { WorkspaceFormRenderer } from './WorkspaceFormRenderer';
import { CardItem } from '../CardManager';
import { SearchableCardManager } from '../SearchableCardManager';
import { ProjectWorkspace } from '../../database/workspace-types';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import type { CreateTaskData, TaskListOptions, UpdateTaskData } from '../../agents/taskManager/types';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskPriority, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';
import type { PaginatedResult } from '../../types/pagination/PaginationTypes';

type ProjectStatus = ProjectMetadata['status'];

interface ProjectCardItem extends CardItem {
    taskSummary: string;
}

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
    safeRegisterDomEvent: <K extends keyof HTMLElementEventMap>(el: HTMLElement, eventName: K, handler: (event: HTMLElementEventMap[K]) => void) => void;
}

export class WorkspaceDetailRenderer {
    private formRenderer?: WorkspaceFormRenderer;
    private component?: Component;

    constructor(component?: Component) {
        this.component = component;
    }

    private async confirmDangerousAction(message: string): Promise<boolean> {
        return await new Promise<boolean>((resolve) => {
            const overlay = document.body.createDiv('modal-container');
            const modal = overlay.createDiv('modal nexus-workspace-confirm-modal');
            const content = modal.createDiv('modal-content');

            content.createEl('h2', { text: 'Confirm action' });
            content.createEl('p', { text: message });

            const buttons = content.createDiv('modal-button-container');
            const cancelButton = buttons.createEl('button', {
                text: 'Cancel',
                cls: 'mod-cancel'
            });
            const confirmButton = buttons.createEl('button', {
                text: 'Delete',
                cls: 'mod-warning'
            });

            const cleanup = (result: boolean) => {
                overlay.remove();
                resolve(result);
            };

            cancelButton.addEventListener('click', () => cleanup(false));
            confirmButton.addEventListener('click', () => cleanup(true));
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    cleanup(false);
                }
            });
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
            () => callbacks.onRefreshDetail()
        );

        this.formRenderer.render(formContainer);

        this.renderProjectsSection(container, workspace, callbacks);

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
        const section = container.createDiv('nexus-form-section');
        section.createEl('h4', { text: 'Projects', cls: 'nexus-section-header' });

        if (!workspace.id) {
            section.createEl('p', {
                text: 'Save this workspace before managing projects and tasks.',
                cls: 'nexus-form-hint'
            });
            return;
        }

        section.createEl('p', {
            text: 'Manage workspace projects and project tasks using the same settings navigation pattern as workflows.',
            cls: 'nexus-form-hint'
        });

        new ButtonComponent(section)
            .setButtonText('Manage projects')
            .onClick(() => {
                callbacks.onNavigateProjects();
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
            text: `${workspace.name || 'Workspace'} projects`,
            cls: 'nexus-detail-title'
        });

        const contentContainer = container.createDiv('nexus-settings-page-content');

        const cardItems: ProjectCardItem[] = projects.map(project => {
            const projectTasks = tasks.filter(task => task.projectId === project.id);
            const openCount = projectTasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').length;
            const doneCount = projectTasks.filter(task => task.status === 'done').length;

            return {
                id: project.id,
                name: project.name,
                description: project.description || 'No description',
                isEnabled: project.status !== 'archived',
                taskSummary: `${projectTasks.length} tasks · ${openCount} open · ${doneCount} done`
            };
        });

        const cardsWithSummary = cardItems.map(item => ({
            ...item,
            description: `${item.description}\n${item.taskSummary}`
        }));

        new SearchableCardManager<CardItem>({
            containerEl: contentContainer,
            cardManagerConfig: {
                title: 'Projects',
                addButtonText: '+ New project',
                emptyStateText: 'No projects yet. Create one to get started.',
                showToggle: false,
                onAdd: () => {
                    callbacks.onNavigateProjectDetail();
                },
                onToggle: () => {
                    return;
                },
                onEdit: (item) => {
                    const project = projects.find(entry => entry.id === item.id);
                    if (project) {
                        callbacks.onOpenProjectDetail(project);
                    }
                },
                onDelete: (item) => {
                    void this.deleteProject(item.id, callbacks);
                }
            },
            items: cardsWithSummary,
            search: {
                placeholder: 'Search projects...'
            }
        });
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
        if (!workspace.id || !project) {
            callbacks.onNavigateProjects();
            return;
        }

        this.renderBreadcrumbs(container, [
            { label: 'Workspaces', onClick: () => callbacks.onNavigateList() },
            { label: workspace.name || 'Workspace', onClick: () => callbacks.onNavigateDetail() },
            { label: 'Projects', onClick: () => callbacks.onNavigateProjects() },
            { label: project.name || 'Project' }
        ]);

        container.createEl('h3', {
            text: project.id ? project.name || 'Project' : 'New Project',
            cls: 'nexus-detail-title'
        });

        const formContainer = container.createDiv('nexus-workspace-form');
        const section = formContainer.createDiv('nexus-form-section');
        section.createEl('h4', { text: 'Project details', cls: 'nexus-section-header' });

        const nameField = section.createDiv('nexus-form-field');
        nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
        const nameInput = new TextComponent(nameField);
        nameInput.setPlaceholder('Project name');
        nameInput.setValue(project.name ?? '');
        nameInput.onChange((value) => { project.name = value; });

        const descField = section.createDiv('nexus-form-field');
        descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        const descInput = new TextAreaComponent(descField);
        descInput.setPlaceholder('Optional project description');
        descInput.setValue(project.description ?? '');
        descInput.onChange((value) => { project.description = value; });
        descInput.inputEl.rows = 3;

        const statusField = section.createDiv('nexus-form-field');
        statusField.createEl('label', { text: 'Status', cls: 'nexus-form-label' });
        const statusDropdown = new DropdownComponent(statusField);
        statusDropdown.addOption('active', 'Active');
        statusDropdown.addOption('completed', 'Completed');
        statusDropdown.addOption('archived', 'Archived');
        statusDropdown.setValue(project.status ?? '');
        statusDropdown.onChange((value) => { project.status = value as ProjectStatus; });

        const actions = container.createDiv('nexus-form-actions');
        new ButtonComponent(actions)
            .setButtonText('Save project')
            .setCta()
            .onClick(() => void onSaveProject());

        if (project.id) {
            new ButtonComponent(actions)
                .setButtonText('Delete project')
                .setWarning()
                .onClick(() => {
                    if (project.id) {
                        void this.deleteProject(project.id, callbacks);
                    }
                });
        }

        if (!project.id) return;

        const tasksSection = container.createDiv('nexus-form-section');
        tasksSection.createEl('h4', { text: 'Tasks', cls: 'nexus-section-header' });

        const taskToolbar = tasksSection.createDiv('nexus-task-toolbar');
        new ButtonComponent(taskToolbar)
            .setButtonText('+ new task')
            .onClick(() => onOpenTaskDetail());

        if (tasks.length === 0) {
            tasksSection.createEl('p', {
                text: 'No tasks yet. Add one to get started.',
                cls: 'nexus-form-hint'
            });
            return;
        }

        const table = tasksSection.createEl('table', { cls: 'nexus-task-table' });
        const head = table.createEl('thead');
        const headerRow = head.createEl('tr');
        ['Done', 'Title', 'Status', 'Priority', 'Due', 'Assignee', 'Actions'].forEach(title => {
            headerRow.createEl('th', { text: title });
        });

        const body = table.createEl('tbody');
        this.buildTaskRows(tasks).forEach(({ task, depth }) => {
            const row = body.createEl('tr');
            row.addClass('nexus-task-row');

            const checkboxCell = row.createEl('td', { cls: 'nexus-task-checkbox-cell' });
            const checkbox = checkboxCell.createEl('input', {
                type: 'checkbox',
                cls: 'nexus-task-checkbox'
            });
            checkbox.checked = task.status === 'done';
            callbacks.safeRegisterDomEvent(checkbox, 'change', () => {
                void this.handleTaskCheckboxChange(task, checkbox.checked, callbacks);
            });

            const titleCell = row.createEl('td', { cls: 'nexus-task-title-cell' });
            titleCell.setAttribute('data-depth', String(depth));
            titleCell.createEl('span', {
                text: `${'— '.repeat(depth)}${task.title}`,
                cls: 'nexus-task-title'
            });

            row.createEl('td', { text: this.formatTaskStatus(task.status) });
            row.createEl('td', { text: task.priority });
            row.createEl('td', { text: this.formatDate(task.dueDate) });
            row.createEl('td', { text: task.assignee || '—' });

            const actionsCell = row.createEl('td');
            actionsCell.addClass('nexus-task-actions');
            new ButtonComponent(actionsCell)
                .setButtonText('Edit')
                .onClick(() => onOpenTaskDetail(task));
            new ButtonComponent(actionsCell)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => void this.deleteTask(task.id, callbacks));
        });
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

    buildTaskRows(tasks: TaskMetadata[]): Array<{ task: TaskMetadata; depth: number }> {
        const children = new Map<string, TaskMetadata[]>();
        const roots: TaskMetadata[] = [];

        const sortTasks = (items: TaskMetadata[]) => items.sort((a, b) => {
            const statusOrder: Record<TaskStatus, number> = {
                todo: 0, in_progress: 1, done: 2, cancelled: 3
            };
            const priorityOrder: Record<TaskPriority, number> = {
                critical: 0, high: 1, medium: 2, low: 3
            };

            const statusDiff = statusOrder[a.status] - statusOrder[b.status];
            if (statusDiff !== 0) return statusDiff;

            const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
            if (priorityDiff !== 0) return priorityDiff;

            return a.created - b.created;
        });

        tasks.forEach(task => {
            if (task.parentTaskId) {
                const list = children.get(task.parentTaskId) || [];
                list.push(task);
                children.set(task.parentTaskId, list);
            } else {
                roots.push(task);
            }
        });

        sortTasks(roots);
        Array.from(children.values()).forEach(sortTasks);

        const rows: Array<{ task: TaskMetadata; depth: number }> = [];
        const visit = (task: TaskMetadata, depth: number) => {
            rows.push({ task, depth });
            const childRows = children.get(task.id) || [];
            childRows.forEach(child => visit(child, depth + 1));
        };

        roots.forEach(task => visit(task, 0));
        return rows;
    }

    private formatTaskStatus(status: TaskStatus): string {
        if (status === 'in_progress') return 'In progress';
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    private formatDate(timestamp?: number): string {
        if (!timestamp) return '—';
        return new Date(timestamp).toLocaleDateString();
    }

    private async deleteProject(projectId: string, callbacks: DetailCallbacks): Promise<void> {
        const confirmed = await this.confirmDangerousAction('Delete this project and all its tasks? This cannot be undone.');
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
        const confirmed = await this.confirmDangerousAction('Delete this task? This cannot be undone.');
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

    private async handleTaskCheckboxChange(
        task: TaskMetadata,
        checked: boolean,
        callbacks: DetailCallbacks
    ): Promise<void> {
        const taskService = await callbacks.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.updateTask(task.id, {
                status: checked ? 'done' : 'todo'
            });
            task.status = checked ? 'done' : 'todo';
            callbacks.onNavigateProjectDetail();
        } catch (error) {
            console.error('[WorkspaceDetailRenderer] Failed to update task status:', error);
            new Notice('Failed to update task status');
        }
    }

    destroyForm(): void {
        this.formRenderer?.destroy();
    }
}
