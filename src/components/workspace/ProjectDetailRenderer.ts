/**
 * ProjectDetailRenderer — sibling-extracted renderer for the project-detail
 * subview. Parallels WorkspaceFormRenderer / StatesSectionRenderer in shape:
 * constructor receives (app, component); render(container, callbacks)
 * idempotently emits the full surface.
 *
 * Composition:
 *   - Breadcrumb: Workspaces → {workspace-name} → Projects → {project-name}
 *   - h3 project-name title
 *   - BoxedSection "Project details" — inline name/desc/status editor + Save/Delete
 *   - BoxedSection "Tasks" — flex `.setting-item.is-task` rows via TaskRowBuilder
 *     (NO leading checkbox per V3; Edit + Delete icon buttons per row)
 *
 * Wave 3 PR2 Commit 2 — extracted from WorkspaceDetailRenderer.renderProjectDetail.
 */

import { App, ButtonComponent, Component, DropdownComponent, setIcon, TextAreaComponent, TextComponent } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { BreadcrumbNav } from '../../settings/components/BreadcrumbNav';
import { TaskRowBuilder } from './TaskRowBuilder';
import { ProjectWorkspace } from '../../database/workspace-types';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata } from '../../database/repositories/interfaces/ITaskRepository';

type ProjectStatus = ProjectMetadata['status'];

export interface ProjectDetailEditorState {
    id?: string;
    workspaceId: string;
    name: string;
    description: string;
    status: ProjectStatus;
}

export interface ProjectDetailCallbacks {
    getWorkspace: () => Partial<ProjectWorkspace>;
    getProject: () => ProjectDetailEditorState;
    getTasks: () => TaskMetadata[];
    onNavigateList: () => void;
    onNavigateDetail: () => void;
    onNavigateProjects: () => void;
    onSaveProject: () => Promise<void>;
    onDeleteProject: (projectId: string) => Promise<void>;
    onOpenTaskDetail: (task?: TaskMetadata) => void;
    onDeleteTask: (taskId: string) => Promise<void>;
}

export class ProjectDetailRenderer {
    constructor(
        private app: App,
        private component: Component
    ) {}

    render(container: HTMLElement, callbacks: ProjectDetailCallbacks): void {
        const workspace = callbacks.getWorkspace();
        const project = callbacks.getProject();

        if (!workspace.id || !project) {
            callbacks.onNavigateProjects();
            return;
        }

        new BreadcrumbNav(container, [
            { label: 'Workspaces', onClick: () => callbacks.onNavigateList() },
            { label: workspace.name || 'Workspace', onClick: () => callbacks.onNavigateDetail() },
            { label: 'Projects', onClick: () => callbacks.onNavigateProjects() },
            { label: project.name || 'Project' }
        ], this.component);

        container.createEl('h3', {
            text: project.id ? project.name || 'Project' : 'New Project',
            cls: 'nexus-detail-title'
        });

        this.renderProjectInfoSection(container, project, callbacks);

        if (project.id) {
            this.renderTasksSection(container, project, callbacks);
        }
    }

    private renderProjectInfoSection(
        container: HTMLElement,
        project: ProjectDetailEditorState,
        callbacks: ProjectDetailCallbacks
    ): void {
        new BoxedSection(container, {
            title: 'Project details',
            unbounded: true,
            body: (body) => {
                const nameField = body.createDiv('nexus-form-field');
                nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
                const nameInput = new TextComponent(nameField);
                nameInput.setPlaceholder('Project name');
                nameInput.setValue(project.name ?? '');
                nameInput.onChange((value) => { project.name = value; });

                const descField = body.createDiv('nexus-form-field');
                descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
                const descInput = new TextAreaComponent(descField);
                descInput.setPlaceholder('Optional project description');
                descInput.setValue(project.description ?? '');
                descInput.onChange((value) => { project.description = value; });
                descInput.inputEl.rows = 3;

                const statusField = body.createDiv('nexus-form-field');
                statusField.createEl('label', { text: 'Status', cls: 'nexus-form-label' });
                const statusDropdown = new DropdownComponent(statusField);
                statusDropdown.addOption('active', 'Active');
                statusDropdown.addOption('completed', 'Completed');
                statusDropdown.addOption('archived', 'Archived');
                statusDropdown.setValue(project.status ?? 'active');
                statusDropdown.onChange((value) => { project.status = value as ProjectStatus; });

                const actions = body.createDiv('nexus-form-actions');
                new ButtonComponent(actions)
                    .setButtonText('Save project')
                    .setCta()
                    .onClick(() => void callbacks.onSaveProject());

                if (project.id) {
                    const projectId = project.id;
                    new ButtonComponent(actions)
                        .setButtonText('Delete project')
                        .setWarning()
                        .onClick(() => void callbacks.onDeleteProject(projectId));
                }
            }
        }, this.component);
    }

    private renderTasksSection(
        container: HTMLElement,
        project: ProjectDetailEditorState,
        callbacks: ProjectDetailCallbacks
    ): void {
        new BoxedSection(container, {
            title: 'Tasks',
            unbounded: true,
            actionLabel: '+ New task',
            onAction: () => callbacks.onOpenTaskDetail(),
            body: (body) => {
                const tasks = callbacks.getTasks();

                if (tasks.length === 0) {
                    body.createEl('p', {
                        text: 'No tasks yet. Add one to get started.',
                        cls: 'nexus-form-hint'
                    });
                    return;
                }

                TaskRowBuilder.buildRows(tasks).forEach(({ task, depth }) => {
                    this.renderTaskRow(body, task, depth, callbacks);
                });
            }
        }, this.component);
    }

    private renderTaskRow(
        body: HTMLElement,
        task: TaskMetadata,
        depth: number,
        callbacks: ProjectDetailCallbacks
    ): void {
        const row = body.createDiv({
            cls: 'setting-item is-task' + (task.status === 'done' ? ' is-done' : '')
        });
        row.setAttribute('data-depth', String(depth));

        const info = row.createDiv('setting-item-info');
        info.createDiv({
            cls: 'setting-item-name',
            text: `${'— '.repeat(depth)}${task.title}`
        });

        const meta = info.createDiv('task-meta');

        const priorityMeta = meta.createSpan({ cls: 'task-meta-item' });
        priorityMeta.createSpan({ cls: `task-meta-dot is-${task.priority}` });
        priorityMeta.createSpan({ text: TaskRowBuilder.formatStatus(task.status) });

        if (task.dueDate) {
            const now = Date.now();
            const overdue = task.dueDate < now && task.status !== 'done' && task.status !== 'cancelled';
            meta.createSpan({
                cls: 'task-meta-item' + (overdue ? ' is-overdue' : ''),
                text: `Due ${TaskRowBuilder.formatDate(task.dueDate)}`
            });
        }

        if (task.assignee) {
            meta.createSpan({
                cls: 'task-meta-item',
                text: `@${task.assignee}`
            });
        }

        const control = row.createDiv('setting-item-control');

        const editBtn = control.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Edit task' }
        });
        setIcon(editBtn, 'pencil');
        this.component.registerDomEvent(editBtn, 'click', () => callbacks.onOpenTaskDetail(task));

        const deleteBtn = control.createEl('button', {
            cls: 'clickable-icon nexus-icon-danger',
            attr: { 'aria-label': 'Delete task' }
        });
        setIcon(deleteBtn, 'trash');
        this.component.registerDomEvent(deleteBtn, 'click', () => void callbacks.onDeleteTask(task.id));
    }
}
