/**
 * WorkspacesTab - Workspace list and detail view
 *
 * Features:
 * - List view showing all workspaces with status badges
 * - Detail view with 3 sub-tabs (Basic Info, Context, Agent & Files)
 * - Workflow editing with dedicated view
 * - Auto-save on all changes
 */

import { App, Notice, ButtonComponent, Component, DropdownComponent, TextComponent, TextAreaComponent } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { BreadcrumbNav, BreadcrumbNavItem } from '../components/BreadcrumbNav';
import { WorkspaceFormRenderer } from '../../components/workspace/WorkspaceFormRenderer';
import { WorkflowEditorRenderer, Workflow } from '../../components/workspace/WorkflowEditorRenderer';
import { FilePickerRenderer } from '../../components/workspace/FilePickerRenderer';
import { ProjectWorkspace } from '../../database/workspace-types';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { CardManager, CardItem } from '../../components/CardManager';
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
    private formRenderer?: WorkspaceFormRenderer;
    private workflowRenderer?: WorkflowEditorRenderer;
    private filePickerRenderer?: FilePickerRenderer;

    // Auto-save debounce
    private saveTimeout?: ReturnType<typeof setTimeout>;

    // Card manager for list view
    private cardManager?: CardManager<any>;

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

        // Check if we have prefetched data (array, even if empty)
        if (Array.isArray(services.prefetchedWorkspaces)) {
            // Use prefetched data - no loading needed
            this.workspaces = services.prefetchedWorkspaces!;
            this.isLoading = false;
            this.render();
        } else {
            // Render immediately with loading state
            this.render();

            // Load data in background
            this.loadWorkspaces().then(() => {
                this.isLoading = false;
                this.render();
            });
        }
    }

    /**
     * Load workspaces from service, awaiting initialization if needed
     */
    private async loadWorkspaces(): Promise<void> {
        let workspaceService = this.services.workspaceService;

        // Wait for both workspaceService and hybridStorageAdapter concurrently.
        // The adapter takes ~3s (WASM loading delay); without it, getAllWorkspaces()
        // falls back to JSONL which only has the default workspace.
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
                // Service unavailable — fall through to show empty state
            }
        }

        if (!workspaceService) {
            return;
        }

        try {
            this.workspaces = await workspaceService.getAllWorkspaces();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to load workspaces:', error);
            this.workspaces = [];
        }
    }

    /**
     * Main render method
     */
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
            this.renderProjects();
            return;
        }

        if (this.currentView === 'project-detail') {
            this.renderProjectDetail();
            return;
        }

        if (this.currentView === 'task-detail') {
            this.renderTaskDetail();
            return;
        }

        const state = this.router.getState();

        // Check router state for navigation
        if (state.view === 'detail' && state.detailId) {
            this.currentView = 'detail';
            const workspace = this.workspaces.find(w => w.id === state.detailId);
            if (workspace) {
                this.currentWorkspace = { ...workspace };
                this.renderDetail();
                return;
            }
        }

        // Default to list view
        this.currentView = 'list';
        this.renderList();
    }

    /**
     * Render list view using CardManager
     */
    private renderList(): void {
        this.container.empty();
        this.currentProject = null;
        this.currentTask = null;
        this.currentProjects = [];
        this.currentTasks = [];
        this.editingTaskOriginal = null;

        // Header
        this.container.createEl('h3', { text: 'Workspaces' });
        this.container.createEl('p', {
            text: 'Organize your vault into focused workspaces',
            cls: 'setting-item-description'
        });

        // Show loading skeleton while loading
        if (this.isLoading) {
            this.renderLoadingSkeleton();
            return;
        }

        // Check if service is available
        if (!this.services.workspaceService) {
            this.container.createEl('p', {
                text: 'Workspace service is initializing...',
                cls: 'nexus-loading-message'
            });
            return;
        }

        // Convert workspaces to CardItem format (defensive: filter invalid + fallback names)
        const cardItems: CardItem[] = this.workspaces
            .filter(workspace => workspace && workspace.id)
            .map(workspace => ({
                id: workspace.id,
                name: workspace.name || 'Untitled Workspace',
                description: workspace.rootFolder || '/',
                isEnabled: workspace.isActive ?? true
            }));

        // Create card manager
        this.cardManager = new CardManager({
            containerEl: this.container,
            title: 'Workspaces',
            addButtonText: '+ New Workspace',
            emptyStateText: 'No workspaces yet. Create one to get started.',
            items: cardItems,
            showToggle: true,
            onAdd: () => this.createNewWorkspace(),
            onToggle: async (item, enabled) => {
                const workspace = this.workspaces.find(w => w.id === item.id);
                if (workspace && this.services.workspaceService) {
                    await this.services.workspaceService.updateWorkspace(item.id, { isActive: enabled });
                    workspace.isActive = enabled;
                }
            },
            onEdit: (item) => {
                this.router.showDetail(item.id);
            },
            onDelete: async (item) => {
                const confirmed = confirm(`Delete workspace "${item.name}"? This cannot be undone.`);
                if (!confirmed) return;

                try {
                    if (this.services.workspaceService) {
                        await this.services.workspaceService.deleteWorkspace(item.id);
                        this.workspaces = this.workspaces.filter(w => w.id !== item.id);
                        this.cardManager?.updateItems(this.workspaces.map(w => ({
                            id: w.id,
                            name: w.name,
                            description: w.rootFolder || '/',
                            isEnabled: w.isActive ?? true
                        })));
                        new Notice('Workspace deleted');
                    }
                } catch (error) {
                    console.error('[WorkspacesTab] Failed to delete workspace:', error);
                    new Notice('Failed to delete workspace');
                }
            }
        });
    }

    /**
     * Render loading skeleton cards
     */
    private renderLoadingSkeleton(): void {
        const grid = this.container.createDiv('card-manager-grid');

        // Create 3 skeleton cards
        for (let i = 0; i < 3; i++) {
            const skeleton = grid.createDiv('nexus-skeleton-card');
            skeleton.createDiv('nexus-skeleton-title');
            skeleton.createDiv('nexus-skeleton-description');
            skeleton.createDiv('nexus-skeleton-actions');
        }
    }

    /**
     * Render detail view
     */
    private renderDetail(): void {
        this.container.empty();

        if (!this.currentWorkspace) {
            this.router.back();
            return;
        }

        // Back button
        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => {
                void this.saveCurrentWorkspace();
                this.showWorkspaceList();
            } },
            { label: this.currentWorkspace.name || 'Workspace' }
        ]);

        // Workspace name as title
        this.container.createEl('h3', {
            text: this.currentWorkspace.name || 'New Workspace',
            cls: 'nexus-detail-title'
        });

        // Get available agents
        const agents = this.getAvailableAgents();

        // Create form renderer
        const formContainer = this.container.createDiv('workspace-form-container');

        this.formRenderer = new WorkspaceFormRenderer(
            this.currentWorkspace,
            agents,
            (index) => this.openWorkflowEditor(index),
            (index) => {
                void this.runWorkflow(index);
            },
            (index) => this.openFilePicker(index),
            () => this.refreshDetail()
        );

        this.formRenderer.render(formContainer);

        this.renderProjectsSection();

        // Action buttons
        const actions = this.container.createDiv('nexus-form-actions');

        // Save button
        new ButtonComponent(actions)
            .setButtonText('Save')
            .setCta()
            .onClick(async () => {
                // Cancel any pending debounced save to prevent double-save
                if (this.saveTimeout) {
                    clearTimeout(this.saveTimeout);
                    this.saveTimeout = undefined;
                }
                const savedWorkspace = await this.saveCurrentWorkspace();
                if (savedWorkspace) {
                    new Notice('Workspace saved');
                    this.router.back();
                }
            });

        // Delete button (only for existing workspaces)
        if (this.currentWorkspace.id && this.workspaces.some(w => w.id === this.currentWorkspace?.id)) {
            new ButtonComponent(actions)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => this.deleteCurrentWorkspace());
        }
    }

    private renderProjectsSection(): void {
        const section = this.container.createDiv('nexus-form-section');
        section.createEl('h4', { text: 'Projects', cls: 'nexus-section-header' });

        if (!this.currentWorkspace?.id) {
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
            .setButtonText('Manage Projects')
            .onClick(() => {
                void this.openProjectsPage();
            });
    }

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

    private renderProjects(): void {
        this.container.empty();

        if (!this.currentWorkspace?.id) {
            this.currentView = 'detail';
            this.renderDetail();
            return;
        }

        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => this.showWorkspaceList() },
            { label: this.currentWorkspace.name || 'Workspace', onClick: () => this.showWorkspaceDetail() },
            { label: 'Projects' }
        ]);

        this.container.createEl('h3', {
            text: `${this.currentWorkspace.name || 'Workspace'} Projects`,
            cls: 'nexus-detail-title'
        });

        const contentContainer = this.container.createDiv('nexus-settings-page-content');

        const cardItems: ProjectCardItem[] = this.currentProjects.map(project => {
            const projectTasks = this.currentTasks.filter(task => task.projectId === project.id);
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

        this.cardManager = new CardManager({
            containerEl: contentContainer,
            title: 'Projects',
            addButtonText: '+ New Project',
            emptyStateText: 'No projects yet. Create one to get started.',
            items: cardsWithSummary,
            showToggle: false,
            onAdd: () => {
                this.currentProject = this.createProjectEditorState();
                this.currentTasks = [];
                this.currentView = 'project-detail';
                this.render();
            },
            onToggle: async () => {
                return;
            },
            onEdit: (item) => {
                const project = this.currentProjects.find(entry => entry.id === item.id);
                if (project) {
                    void this.openProjectDetail(project);
                }
            },
            onDelete: (item) => {
                void this.deleteProject(item.id);
            }
        });
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

    private renderProjectDetail(): void {
        this.container.empty();

        if (!this.currentWorkspace?.id || !this.currentProject) {
            this.currentView = 'projects';
            this.render();
            return;
        }

        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => this.showWorkspaceList() },
            { label: this.currentWorkspace.name || 'Workspace', onClick: () => this.showWorkspaceDetail() },
            { label: 'Projects', onClick: () => this.showProjectsPage() },
            { label: this.currentProject.name || 'Project' }
        ]);

        this.container.createEl('h3', {
            text: this.currentProject.id ? this.currentProject.name || 'Project' : 'New Project',
            cls: 'nexus-detail-title'
        });

        const formContainer = this.container.createDiv('nexus-workspace-form');
        const section = formContainer.createDiv('nexus-form-section');
        section.createEl('h4', { text: 'Project Details', cls: 'nexus-section-header' });

        const nameField = section.createDiv('nexus-form-field');
        nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
        const nameInput = new TextComponent(nameField);
        nameInput.setPlaceholder('Project name');
        nameInput.setValue(this.currentProject.name);
        nameInput.onChange((value) => {
            if (this.currentProject) {
                this.currentProject.name = value;
            }
        });

        const descField = section.createDiv('nexus-form-field');
        descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        const descInput = new TextAreaComponent(descField);
        descInput.setPlaceholder('Optional project description');
        descInput.setValue(this.currentProject.description);
        descInput.onChange((value) => {
            if (this.currentProject) {
                this.currentProject.description = value;
            }
        });
        descInput.inputEl.rows = 3;

        const statusField = section.createDiv('nexus-form-field');
        statusField.createEl('label', { text: 'Status', cls: 'nexus-form-label' });
        const statusDropdown = new DropdownComponent(statusField);
        statusDropdown.addOption('active', 'Active');
        statusDropdown.addOption('completed', 'Completed');
        statusDropdown.addOption('archived', 'Archived');
        statusDropdown.setValue(this.currentProject.status);
        statusDropdown.onChange((value) => {
            if (this.currentProject) {
                this.currentProject.status = value as ProjectStatus;
            }
        });

        const actions = this.container.createDiv('nexus-form-actions');
        new ButtonComponent(actions)
            .setButtonText('Save Project')
            .setCta()
            .onClick(() => {
                void this.saveProjectDetail();
            });

        if (this.currentProject.id) {
            new ButtonComponent(actions)
                .setButtonText('Delete Project')
                .setWarning()
                .onClick(() => {
                    if (this.currentProject?.id) {
                        void this.deleteProject(this.currentProject.id);
                    }
                });
        }

        if (!this.currentProject.id) {
            return;
        }

        const tasksSection = this.container.createDiv('nexus-form-section');
        tasksSection.createEl('h4', { text: 'Tasks', cls: 'nexus-section-header' });

        const taskToolbar = tasksSection.createDiv('nexus-task-toolbar');
        new ButtonComponent(taskToolbar)
            .setButtonText('+ New Task')
            .onClick(() => {
                this.openTaskDetail();
            });

        if (this.currentTasks.length === 0) {
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
        this.buildTaskRows(this.currentTasks).forEach(({ task, depth }) => {
            const row = body.createEl('tr');
            row.addClass('nexus-task-row');

            const checkboxCell = row.createEl('td', { cls: 'nexus-task-checkbox-cell' });
            const checkbox = checkboxCell.createEl('input', {
                type: 'checkbox',
                cls: 'nexus-task-checkbox'
            });
            checkbox.checked = task.status === 'done';
            this.safeRegisterDomEvent(checkbox, 'change', () => {
                void this.handleTaskCheckboxChange(task, checkbox.checked);
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
                .onClick(() => {
                    this.openTaskDetail(task);
                });
            new ButtonComponent(actionsCell)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => {
                    void this.deleteTask(task.id);
                });
        });
    }

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

    private renderTaskDetail(): void {
        this.container.empty();

        if (!this.currentProject?.id || !this.currentWorkspace?.id || !this.currentTask) {
            this.currentView = 'project-detail';
            this.render();
            return;
        }

        this.renderBreadcrumbs([
            { label: 'Workspaces', onClick: () => this.showWorkspaceList() },
            { label: this.currentWorkspace.name || 'Workspace', onClick: () => this.showWorkspaceDetail() },
            { label: 'Projects', onClick: () => this.showProjectsPage() },
            { label: this.currentProject.name || 'Project', onClick: () => this.showProjectPage() },
            { label: this.currentTask.id ? (this.currentTask.title || 'Task') : 'New Task' }
        ]);

        this.container.createEl('h3', {
            text: this.currentTask.id ? 'Edit Task' : 'New Task',
            cls: 'nexus-detail-title'
        });

        const form = this.container.createDiv('nexus-workspace-form');
        const details = form.createDiv('nexus-form-section');
        details.createEl('h4', { text: 'Task Details', cls: 'nexus-section-header' });

        const titleField = details.createDiv('nexus-form-field');
        titleField.createEl('label', { text: 'Title', cls: 'nexus-form-label' });
        const titleInput = new TextComponent(titleField);
        titleInput.setPlaceholder('Task title');
        titleInput.setValue(this.currentTask.title);
        titleInput.onChange((value) => {
            if (this.currentTask) {
                this.currentTask.title = value;
            }
        });

        const descriptionField = details.createDiv('nexus-form-field');
        descriptionField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        const descriptionInput = new TextAreaComponent(descriptionField);
        descriptionInput.setPlaceholder('Optional task description');
        descriptionInput.setValue(this.currentTask.description);
        descriptionInput.onChange((value) => {
            if (this.currentTask) {
                this.currentTask.description = value;
            }
        });
        descriptionInput.inputEl.rows = 4;

        const metaGrid = details.createDiv('nexus-task-form-grid');

        this.renderTaskDropdown(metaGrid, 'Status', this.currentTask.status, [
            ['todo', 'Todo'],
            ['in_progress', 'In progress'],
            ['done', 'Done'],
            ['cancelled', 'Cancelled']
        ], (value) => {
            if (this.currentTask) {
                this.currentTask.status = value as TaskStatus;
            }
        });

        this.renderTaskDropdown(metaGrid, 'Priority', this.currentTask.priority, [
            ['critical', 'Critical'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low']
        ], (value) => {
            if (this.currentTask) {
                this.currentTask.priority = value as TaskPriority;
            }
        });

        this.renderTaskDropdown(
            metaGrid,
            'Project',
            this.currentTask.projectId,
            this.currentProjects.map(project => [project.id, project.name] as [string, string]),
            (value) => {
                if (this.currentTask) {
                    this.currentTask.projectId = value;
                }
            },
            false
        );

        const parentOptions: Array<[string, string]> = [['', 'None']];
        this.currentTasks
            .filter(task => task.id !== this.currentTask?.id)
            .forEach(task => {
                parentOptions.push([task.id, task.title]);
            });
        this.renderTaskDropdown(metaGrid, 'Parent Task', this.currentTask.parentTaskId, parentOptions, (value) => {
            if (this.currentTask) {
                this.currentTask.parentTaskId = value;
            }
        });

        this.renderTaskTextField(metaGrid, 'Assignee', this.currentTask.assignee, (value) => {
            if (this.currentTask) {
                this.currentTask.assignee = value;
            }
        });

        this.renderTaskTextField(metaGrid, 'Due Date', this.currentTask.dueDate, (value) => {
            if (this.currentTask) {
                this.currentTask.dueDate = value;
            }
        }, 'date');

        const tagsField = details.createDiv('nexus-form-field');
        tagsField.createEl('label', { text: 'Tags', cls: 'nexus-form-label' });
        const tagsInput = new TextComponent(tagsField);
        tagsInput.setPlaceholder('Comma-separated tags');
        tagsInput.setValue(this.currentTask.tags);
        tagsInput.onChange((value) => {
            if (this.currentTask) {
                this.currentTask.tags = value;
            }
        });

        const actions = this.container.createDiv('nexus-form-actions');
        new ButtonComponent(actions)
            .setButtonText('Save Task')
            .setCta()
            .onClick(() => {
                void this.saveTaskDetail();
            });

        if (this.currentTask.id) {
            new ButtonComponent(actions)
                .setButtonText('Delete Task')
                .setWarning()
                .onClick(() => {
                    if (this.currentTask?.id) {
                        void this.deleteTask(this.currentTask.id);
                    }
                });
        }
    }

    /**
     * Render workflow editor view
     */
    private renderWorkflowEditor(): void {
        this.container.empty();

        if (!this.currentWorkspace || !this.currentWorkspace.context) {
            this.currentView = 'detail';
            this.renderDetail();
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
            (savedWorkflow) => {
                void this.saveWorkflow(savedWorkflow);
            },
            () => {
                this.currentView = 'detail';
                this.renderDetail();
            },
            async (workflowToRun) => {
                await this.runWorkflowFromEditor(workflowToRun);
            }
        );

        this.workflowRenderer.render(contentContainer, workflow, isNew, { showBackButton: false });
    }

    /**
     * Get available custom agents
     */
    private getAvailableAgents(): CustomPrompt[] {
        if (!this.services.customPromptStorage) return [];
        return this.services.customPromptStorage.getAllPrompts();
    }

    /**
     * Create a new workspace
     */
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
        this.renderDetail();
    }

    /**
     * Save the current workspace
     */
    private async saveCurrentWorkspace(): Promise<ProjectWorkspace | null> {
        if (!this.currentWorkspace || !this.services.workspaceService) return null;

        try {
            const existingIndex = this.workspaces.findIndex(w => w.id === this.currentWorkspace?.id);

            if (existingIndex >= 0) {
                // Update existing
                await this.services.workspaceService.updateWorkspace(
                    this.currentWorkspace.id!,
                    this.currentWorkspace
                );
                this.workspaces[existingIndex] = this.currentWorkspace as ProjectWorkspace;
                return this.currentWorkspace as ProjectWorkspace;
            } else {
                // Create new
                const created = await this.services.workspaceService.createWorkspace(
                    this.currentWorkspace
                );
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

    /**
     * Delete the current workspace
     */
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

    /**
     * Open workflow editor
     */
    private openWorkflowEditor(index?: number): void {
        this.currentWorkflowIndex = index ?? -1;
        this.currentView = 'workflow';
        this.renderWorkflowEditor();
    }

    /**
     * Save workflow and return to detail view
     */
    private async saveWorkflow(workflow: Workflow, options?: {
        returnToDetail?: boolean;
        runAfterSave?: boolean;
    }): Promise<void> {
        const persistedWorkflow = await this.persistWorkflow(workflow);
        if (!persistedWorkflow) {
            return;
        }

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
        this.renderDetail();
        new Notice('Workflow saved');
    }

    /**
     * Open file picker
     */
    private openFilePicker(index: number): void {
        this.currentFileIndex = index;
        this.currentView = 'filepicker';
        this.renderFilePicker();
    }

    /**
     * Render file picker view
     */
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
                this.renderDetail();
            },
            () => {
                this.currentView = 'detail';
                this.renderDetail();
            },
            currentPath,
            workspaceRoot,
            undefined, // title
            this.services.component,
            false
        );

        this.filePickerRenderer.render(contentContainer);
    }

    /**
     * Refresh the detail view
     */
    private refreshDetail(): void {
        if (this.currentView === 'detail') {
            this.renderDetail();
        }
    }

    private async runWorkflow(index: number): Promise<void> {
        const workflow = this.currentWorkspace?.context?.workflows?.[index];
        if (!workflow?.id) {
            new Notice('Save this workflow before running it');
            return;
        }

        const savedWorkspace = await this.saveCurrentWorkspace();
        if (!savedWorkspace) {
            return;
        }

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
        await this.saveWorkflow(workflow, {
            runAfterSave: true,
            returnToDetail: false
        });
    }

    private async persistWorkflow(workflow: Workflow): Promise<Workflow | null> {
        if (!this.currentWorkspace) {
            return null;
        }

        if (!this.currentWorkspace.context) {
            this.currentWorkspace.context = {
                purpose: '',
                workflows: [],
                keyFiles: [],
                preferences: ''
            };
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
        if (!savedWorkspace) {
            return null;
        }

        this.currentWorkspace = { ...savedWorkspace };
        const savedWorkflow = savedWorkspace.context?.workflows?.find(item => item.id === normalizedWorkflow.id);
        if (!savedWorkflow) {
            return normalizedWorkflow;
        }

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

    private createProjectEditorState(project?: ProjectMetadata): ProjectEditorState {
        return {
            id: project?.id,
            workspaceId: project?.workspaceId || this.currentWorkspace?.id || '',
            name: project?.name || '',
            description: project?.description || '',
            status: project?.status || 'active'
        };
    }

    private renderBreadcrumbs(items: BreadcrumbNavItem[]): void {
        new BreadcrumbNav(this.container, items, this.services.component);
    }

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

    private async saveProjectDetail(): Promise<void> {
        if (!this.currentProject || !this.currentWorkspace?.id) {
            return;
        }

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

    private async saveTaskDetail(): Promise<void> {
        if (!this.currentTask || !this.currentWorkspace?.id || !this.currentProject?.id) {
            return;
        }

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

    private async deleteProject(projectId: string): Promise<void> {
        const confirmed = confirm('Delete this project and all its tasks? This cannot be undone.');
        if (!confirmed) {
            return;
        }

        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.deleteProject(projectId);
            await this.refreshProjects();
            this.currentView = 'projects';
            this.render();
            new Notice('Project deleted');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to delete project:', error);
            new Notice('Failed to delete project');
        }
    }

    private async deleteTask(taskId: string): Promise<void> {
        const confirmed = confirm('Delete this task? This cannot be undone.');
        if (!confirmed) {
            return;
        }

        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.deleteTask(taskId);
            await this.refreshProjects();
            const activeProject = this.currentProjects.find(project => project.id === this.currentProject?.id);
            if (activeProject) {
                await this.openProjectDetail(activeProject);
            }
            new Notice('Task deleted');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to delete task:', error);
            new Notice('Failed to delete task');
        }
    }

    private async handleTaskCheckboxChange(task: TaskMetadata, checked: boolean): Promise<void> {
        const taskService = await this.getTaskService();
        if (!taskService) {
            new Notice('Task service is not available yet');
            return;
        }

        try {
            await taskService.updateTask(task.id, {
                status: checked ? 'done' : 'todo'
            });
            const updatedTask = this.currentTasks.find(entry => entry.id === task.id);
            if (updatedTask) {
                updatedTask.status = checked ? 'done' : 'todo';
            }
            this.render();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to update task status:', error);
            new Notice('Failed to update task status');
        }
    }

    private buildTaskRows(tasks: TaskMetadata[]): Array<{ task: TaskMetadata; depth: number }> {
        const children = new Map<string, TaskMetadata[]>();
        const roots: TaskMetadata[] = [];

        const sortTasks = (items: TaskMetadata[]) => items.sort((a, b) => {
            const statusOrder: Record<TaskStatus, number> = {
                todo: 0,
                in_progress: 1,
                done: 2,
                cancelled: 3
            };
            const priorityOrder: Record<TaskPriority, number> = {
                critical: 0,
                high: 1,
                medium: 2,
                low: 3
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
        if (status === 'in_progress') {
            return 'In progress';
        }
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    private formatDate(timestamp?: number): string {
        if (!timestamp) {
            return '—';
        }

        return new Date(timestamp).toLocaleDateString();
    }

    private toDateInputValue(timestamp?: number): string {
        if (!timestamp) {
            return '';
        }

        return new Date(timestamp).toISOString().slice(0, 10);
    }

    private fromDateInputValue(value: string): number | undefined {
        if (!value) {
            return undefined;
        }

        const timestamp = new Date(`${value}T00:00:00`).getTime();
        return Number.isNaN(timestamp) ? undefined : timestamp;
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
        options.forEach(([optionValue, optionLabel]) => dropdown.addOption(optionValue, optionLabel));
        dropdown.setValue(value || '');
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
        this.safeRegisterDomEvent(input, 'input', () => {
            onChange(input.value);
        });
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
        if (!this.currentWorkspace?.id) {
            return;
        }

        const taskService = await this.getTaskService();
        if (!taskService) {
            return;
        }

        const projects = await taskService.listProjects(this.currentWorkspace.id, { pageSize: 1000 });
        this.currentProjects = projects.items;

        const tasksByProject = await Promise.all(
            this.currentProjects.map(project => taskService.listTasks(project.id, { pageSize: 1000, includeSubtasks: true }))
        );
        this.currentTasks = tasksByProject.flatMap(result => result.items);
    }

    private async getTaskService(): Promise<TaskService | null> {
        if (this.taskService !== undefined) {
            return this.taskService;
        }

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
        if (!this.services.serviceManager) {
            return null;
        }

        try {
            return await this.services.serviceManager.getService<WorkflowRunService>('workflowRunService');
        } catch {
            return null;
        }
    }

    /**
     * Debounced auto-save
     */
    private debouncedSave(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.saveCurrentWorkspace();
        }, 500);
    }

    /**
     * Cleanup
     */
    destroy(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.formRenderer?.destroy();
    }
}
