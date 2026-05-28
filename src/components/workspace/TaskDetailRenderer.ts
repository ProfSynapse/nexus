/**
 * TaskDetailRenderer — sibling-extracted renderer for the task-detail subview.
 * Parallels ProjectDetailRenderer in shape: constructor receives (app, component);
 * render(container, callbacks) idempotently emits the full surface.
 *
 * Composition:
 *   - Breadcrumb: Workspaces → {workspace} → Projects → {project} → {task.title}
 *   - h3 task title
 *   - BoxedSection "Task details" — title/description/status/priority/project/
 *     parent/assignee/due-date/tags editor + Save/Delete
 *   - (existing tasks only) BoxedSection "Dependencies" — Depends-on / Blocks groups
 *   - (existing tasks only) BoxedSection "Linked notes" — link/unlink + linkType suffix
 *
 * PURE VIEW: never touches TaskService, never fetches. Reads pre-fetched deps +
 * linked notes via getter callbacks (N+1-safe — the single fetch lives in
 * ProjectsManagerView.openTaskDetail). Emits immediate per-edge mutations via
 * callbacks; the orchestration layer re-fetches + re-renders.
 *
 * Wave 3 PR3 — extracted from WorkspaceDetailRenderer.renderTaskDetail.
 */

import { App, ButtonComponent, Component, DropdownComponent, Notice, setIcon, TextAreaComponent, TextComponent } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { BreadcrumbNav } from '../../settings/components/BreadcrumbNav';
import { ProjectWorkspace } from '../../database/workspace-types';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskStatus, TaskPriority, NoteLink, LinkType } from '../../database/repositories/interfaces/ITaskRepository';

/** Flattened, renderer-facing dependency shape (adapter output — see arch D1). */
export interface TaskDeps {
    upstream: TaskMetadata[];     // tasks THIS task depends on ("Depends on")
    downstream: TaskMetadata[];   // tasks blocked BY this task ("Blocks")
}

/**
 * Form-state shape the renderer binds. Mirrors the in-production TaskEditorState
 * held by ProjectsManagerView (string dueDate/tags from date-input + CSV form
 * fields) — ground truth wins over the arch sketch's numeric dueDate.
 */
export interface TaskDetailEditorState {
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

type DepDirection = 'upstream' | 'downstream';

const STATUS_LABEL: Record<TaskStatus, string> = {
    todo: 'Todo',
    in_progress: 'In progress',
    done: 'Done',
    cancelled: 'Cancelled'
};

export interface TaskDetailCallbacks {
    getWorkspace: () => Partial<ProjectWorkspace>;
    getProject: () => { id?: string; name: string };
    getTask: () => TaskDetailEditorState;
    getAllProjects: () => ProjectMetadata[];
    getAllTasks: () => TaskMetadata[];

    /** Pre-fetched at navigation time (N+1-safe). Renderer never fetches. */
    getDeps: () => TaskDeps;
    getLinkedNotes: () => NoteLink[];

    // Navigation
    onNavigateList: () => void;
    onNavigateDetail: () => void;
    onNavigateProjects: () => void;
    onNavigateProjectDetail: () => void;
    onOpenTaskDetail: (task?: TaskMetadata) => void;

    // Task lifecycle
    onSaveTask: () => Promise<void>;
    onDeleteTask: (taskId: string) => Promise<void>;

    // IMMEDIATE per-edge dependency mutation (arch D2).
    onAddTaskDep: (taskId: string, dependsOnTaskId: string) => Promise<void>;
    onRemoveTaskDep: (taskId: string, dependsOnTaskId: string) => Promise<void>;

    // IMMEDIATE per-edge note-link mutation (arch D2).
    onLinkNote: (taskId: string, notePath: string, linkType: LinkType) => Promise<void>;
    onUnlinkNote: (taskId: string, notePath: string) => Promise<void>;

    getApp: () => App;
}

export class TaskDetailRenderer {
    constructor(
        private app: App,
        private component: Component
    ) {}

    render(container: HTMLElement, callbacks: TaskDetailCallbacks): void {
        const workspace = callbacks.getWorkspace();
        const project = callbacks.getProject();
        const task = callbacks.getTask();

        if (!project.id || !workspace.id || !task) {
            callbacks.onNavigateProjectDetail();
            return;
        }

        new BreadcrumbNav(container, [
            { label: 'Workspaces', onClick: () => callbacks.onNavigateList() },
            { label: workspace.name || 'Workspace', onClick: () => callbacks.onNavigateDetail() },
            { label: 'Projects', onClick: () => callbacks.onNavigateProjects() },
            { label: project.name || 'Project', onClick: () => callbacks.onNavigateProjectDetail() },
            { label: task.id ? (task.title || 'Task') : 'New Task' }
        ], this.component);

        container.createEl('h3', {
            text: task.id ? 'Edit task' : 'New task',
            cls: 'nexus-detail-title'
        });

        this.renderTaskDetailsSection(container, task, callbacks);

        // Deps + linked notes only exist for SAVED tasks (both keyed by taskId).
        if (task.id) {
            this.renderDependenciesSection(container, task, callbacks);
            this.renderLinkedNotesSection(container, task, callbacks);
        }
    }

    private renderTaskDetailsSection(
        container: HTMLElement,
        task: TaskDetailEditorState,
        callbacks: TaskDetailCallbacks
    ): void {
        new BoxedSection(container, {
            title: 'Task details',
            unbounded: true,
            body: (body) => {
                const titleField = body.createDiv('nexus-form-field');
                titleField.createEl('label', { text: 'Title', cls: 'nexus-form-label' });
                const titleInput = new TextComponent(titleField);
                titleInput.setPlaceholder('Task title');
                titleInput.setValue(task.title ?? '');
                titleInput.onChange((value) => { task.title = value; });

                const descriptionField = body.createDiv('nexus-form-field');
                descriptionField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
                const descriptionInput = new TextAreaComponent(descriptionField);
                descriptionInput.setPlaceholder('Optional task description');
                descriptionInput.setValue(task.description ?? '');
                descriptionInput.onChange((value) => { task.description = value; });
                descriptionInput.inputEl.rows = 4;

                const metaGrid = body.createDiv('nexus-task-form-grid');

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
                    callbacks.getAllProjects().map(p => [p.id, p.name] as [string, string]),
                    (value) => { task.projectId = value; },
                    false
                );

                const parentOptions: Array<[string, string]> = [['', 'None']];
                callbacks.getAllTasks()
                    .filter(t => t.id !== task.id)
                    .forEach(t => parentOptions.push([t.id, t.title]));
                this.renderTaskDropdown(metaGrid, 'Parent Task', task.parentTaskId, parentOptions, (value) => {
                    task.parentTaskId = value;
                });

                this.renderTaskTextField(metaGrid, 'Assignee', task.assignee, (value) => {
                    task.assignee = value;
                });

                this.renderTaskTextField(metaGrid, 'Due Date', task.dueDate, (value) => {
                    task.dueDate = value;
                }, 'date');

                const tagsField = body.createDiv('nexus-form-field');
                tagsField.createEl('label', { text: 'Tags', cls: 'nexus-form-label' });
                const tagsInput = new TextComponent(tagsField);
                tagsInput.setPlaceholder('Comma-separated tags');
                tagsInput.setValue(task.tags ?? '');
                tagsInput.onChange((value) => { task.tags = value; });

                const actions = body.createDiv('nexus-form-actions');
                new ButtonComponent(actions)
                    .setButtonText('Save task')
                    .setCta()
                    .onClick(() => void callbacks.onSaveTask());

                if (task.id) {
                    const taskId = task.id;
                    new ButtonComponent(actions)
                        .setButtonText('Delete task')
                        .setWarning()
                        .onClick(() => void callbacks.onDeleteTask(taskId));
                }
            }
        }, this.component);
    }

    private renderDependenciesSection(
        container: HTMLElement,
        task: TaskDetailEditorState,
        callbacks: TaskDetailCallbacks
    ): void {
        const deps = callbacks.getDeps();

        new BoxedSection(container, {
            title: 'Dependencies',
            unbounded: true,
            body: (body) => {
                // ── "Depends on" group (upstream) ──
                body.createDiv({
                    cls: 'ws-group-label',
                    text: `Depends on · ${deps.upstream.length}`
                });
                if (deps.upstream.length === 0) {
                    body.createEl('p', { text: 'No upstream dependencies.', cls: 'nexus-form-hint' });
                } else {
                    for (const depTask of deps.upstream) {
                        this.renderDepRow(body, task, depTask, 'upstream', callbacks);
                    }
                }
                this.renderAddDependencyControl(body, task, deps, callbacks);

                // ── "Blocks" group (downstream — display-only, no add-control) ──
                body.createDiv({
                    cls: 'ws-group-label',
                    text: `Blocks · ${deps.downstream.length}`
                });
                if (deps.downstream.length === 0) {
                    body.createEl('p', { text: 'No tasks blocked by this one.', cls: 'nexus-form-hint' });
                } else {
                    for (const depTask of deps.downstream) {
                        this.renderDepRow(body, task, depTask, 'downstream', callbacks);
                    }
                }
            }
        }, this.component);
    }

    private renderDepRow(
        body: HTMLElement,
        task: TaskDetailEditorState,
        depTask: TaskMetadata,
        direction: DepDirection,
        callbacks: TaskDetailCallbacks
    ): void {
        const taskId = task.id;
        if (!taskId) return;

        const row = body.createDiv({ cls: 'setting-item is-dep' });

        const info = row.createDiv('setting-item-info');
        info.createDiv({ cls: 'setting-item-name', text: depTask.title });
        // Status pill — 'done' deps are satisfied → no pill (arch §4c).
        if (depTask.status !== 'done') {
            info.createSpan({
                cls: `ws-status-pill is-${depTask.status}`,
                text: STATUS_LABEL[depTask.status]
            });
        }

        const control = row.createDiv('setting-item-control');

        const openBtn = control.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': `Open ${depTask.title}` }
        });
        setIcon(openBtn, 'arrow-right');
        this.component.registerDomEvent(openBtn, 'click', () => callbacks.onOpenTaskDetail(depTask));

        const removeBtn = control.createEl('button', {
            cls: 'clickable-icon mod-warning',
            attr: { 'aria-label': 'Remove dependency' }
        });
        setIcon(removeBtn, 'x');
        this.component.registerDomEvent(removeBtn, 'click', () => {
            // Edge directionality (arch §4b): addDependency(taskId, dependsOnTaskId)
            // means "taskId depends on dependsOnTaskId".
            if (direction === 'upstream') {
                // this task depends on depTask → remove (task.id → depTask.id)
                void callbacks.onRemoveTaskDep(taskId, depTask.id);
            } else {
                // depTask depends on this task → remove (depTask.id → task.id)
                void callbacks.onRemoveTaskDep(depTask.id, taskId);
            }
        });
    }

    private renderAddDependencyControl(
        body: HTMLElement,
        task: TaskDetailEditorState,
        deps: TaskDeps,
        callbacks: TaskDetailCallbacks
    ): void {
        const taskId = task.id;
        if (!taskId) return;

        // UX pre-filter (server is the authority on cycle + cross-project).
        const candidates = callbacks.getAllTasks().filter(t =>
            t.id !== taskId &&
            t.projectId === task.projectId &&
            !deps.upstream.some(u => u.id === t.id)
        );

        if (candidates.length === 0) {
            body.createEl('p', { text: 'No tasks available to add.', cls: 'nexus-form-hint' });
            return;
        }

        const addRow = body.createDiv('ws-field ws-field-inline');
        const dropdown = new DropdownComponent(addRow);
        for (const candidate of candidates) {
            dropdown.addOption(candidate.id, candidate.title);
        }

        new ButtonComponent(addRow)
            .setButtonText('Add dependency')
            .onClick(() => {
                const selectedId = dropdown.getValue();
                if (!selectedId) return;
                void callbacks.onAddTaskDep(taskId, selectedId);
            });
    }

    private renderLinkedNotesSection(
        container: HTMLElement,
        task: TaskDetailEditorState,
        callbacks: TaskDetailCallbacks
    ): void {
        const linkedNotes = callbacks.getLinkedNotes();

        new BoxedSection(container, {
            title: 'Linked notes',
            unbounded: true,
            body: (body) => {
                if (linkedNotes.length === 0) {
                    body.createEl('p', { text: 'No linked notes yet.', cls: 'nexus-form-hint' });
                } else {
                    for (const note of linkedNotes) {
                        this.renderNoteLinkRow(body, task, note, callbacks);
                    }
                }
                this.renderAddNoteLinkControl(body, task, callbacks);
            }
        }, this.component);
    }

    private renderNoteLinkRow(
        body: HTMLElement,
        task: TaskDetailEditorState,
        note: NoteLink,
        callbacks: TaskDetailCallbacks
    ): void {
        const taskId = task.id;
        if (!taskId) return;

        const row = body.createDiv({ cls: 'setting-item is-note-link' });

        const info = row.createDiv('setting-item-info');
        const basename = note.notePath.split('/').pop() ?? note.notePath;
        info.createDiv({ cls: 'setting-item-name', text: basename });
        // linkType is REQUIRED (arch D3) → always render the `· {linkType}` suffix.
        info.createDiv({
            cls: 'setting-item-description',
            text: `${note.notePath} · ${note.linkType}`
        });

        const control = row.createDiv('setting-item-control');
        const removeBtn = control.createEl('button', {
            cls: 'clickable-icon mod-warning',
            attr: { 'aria-label': `Unlink ${basename}` }
        });
        setIcon(removeBtn, 'x');
        this.component.registerDomEvent(removeBtn, 'click', () => void callbacks.onUnlinkNote(taskId, note.notePath));
    }

    private renderAddNoteLinkControl(
        body: HTMLElement,
        task: TaskDetailEditorState,
        callbacks: TaskDetailCallbacks
    ): void {
        const taskId = task.id;
        if (!taskId) return;

        const addRow = body.createDiv('ws-field ws-field-inline');

        // Plain text path input — a FilePicker path-suggester is PR4 scope.
        const pathInput = new TextComponent(addRow);
        pathInput.setPlaceholder('path/to/note.md');

        const linkTypeDropdown = new DropdownComponent(addRow);
        linkTypeDropdown.addOption('reference', 'Reference');
        linkTypeDropdown.addOption('output', 'Output');
        linkTypeDropdown.addOption('input', 'Input');
        linkTypeDropdown.setValue('reference');

        new ButtonComponent(addRow)
            .setButtonText('Link note')
            .onClick(() => {
                const path = pathInput.getValue().trim();
                if (!path) {
                    new Notice('Enter a note path');
                    return;
                }
                const linkType = linkTypeDropdown.getValue() as LinkType;
                void callbacks.onLinkNote(taskId, path, linkType);
            });
    }

    // --- Form-field helpers (moved from WorkspaceDetailRenderer; exclusive to task detail) ---

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
        type: 'text' | 'date' = 'text'
    ): void {
        const field = container.createDiv('nexus-form-field');
        field.createEl('label', { text: label, cls: 'nexus-form-label' });
        const input = field.createEl('input', {
            cls: 'nexus-form-input',
            type
        });
        input.value = value;
        this.component.registerDomEvent(input, 'input', () => {
            onChange(input.value);
        });
    }
}
