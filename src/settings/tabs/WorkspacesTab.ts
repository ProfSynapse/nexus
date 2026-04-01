/**
 * WorkspacesTab - Workspace list and detail view (coordinator)
 *
 * Owns state and navigation. Delegates rendering to:
 * - WorkspaceListRenderer (list view)
 * - WorkspaceDetailRenderer (detail, project, task views)
 * - ProjectsManagerView (project/task state and CRUD)
 * - WorkflowEditorRenderer (workflow editor)
 * - FilePickerRenderer (file picker)
 */

import { App, Notice, Component, Modal, ButtonComponent } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { BreadcrumbNav, BreadcrumbNavItem } from '../components/BreadcrumbNav';
import { WorkflowEditorRenderer, Workflow } from '../../components/workspace/WorkflowEditorRenderer';
import { FilePickerRenderer } from '../../components/workspace/FilePickerRenderer';
import { WorkspaceListRenderer } from '../../components/workspace/WorkspaceListRenderer';
import { WorkspaceDetailRenderer, DetailCallbacks } from '../../components/workspace/WorkspaceDetailRenderer';
import { ProjectsManagerView } from '../../components/workspace/ProjectsManagerView';
import { ProjectWorkspace } from '../../database/workspace-types';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { v4 as uuidv4 } from '../../utils/uuid';
import type { ServiceManager } from '../../core/ServiceManager';
import type { WorkflowRunService } from '../../services/workflows/WorkflowRunService';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';

export interface WorkspacesTabServices {
    app: App;
    workspaceService?: WorkspaceService;
    customPromptStorage?: CustomPromptStorageService;
    prefetchedWorkspaces?: ProjectWorkspace[] | null;
    serviceManager?: ServiceManager;
    component?: Component;
}

type WorkspacesView = 'list' | 'detail' | 'workflow' | 'filepicker' | 'projects' | 'project-detail' | 'task-detail';

export class WorkspacesTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private services: WorkspacesTabServices;
    private workspaces: ProjectWorkspace[] = [];
    private currentWorkspace: Partial<ProjectWorkspace> | null = null;
    private currentWorkflowIndex = -1;
    private currentFileIndex = -1;
    private currentView: WorkspacesView = 'list';

    // Renderers
    private listRenderer: WorkspaceListRenderer;
    private detailRenderer: WorkspaceDetailRenderer;
    private projectsManager: ProjectsManagerView;
    private workflowRenderer?: WorkflowEditorRenderer;
    private filePickerRenderer?: FilePickerRenderer;

    // Auto-save debounce
    private saveTimeout?: ReturnType<typeof setTimeout>;

    // Loading state
    private isLoading = true;

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
        this.projectsManager = new ProjectsManagerView(
            this.detailRenderer,
            services.serviceManager,
            {
                getCurrentWorkspace: () => this.currentWorkspace,
                onNavigateList: () => this.showWorkspaceList(),
                onNavigateDetail: () => this.showWorkspaceDetail(),
                onRender: () => this.render(),
                buildDetailCallbacks: () => this.buildDetailCallbacks()
            }
        );

        if (Array.isArray(services.prefetchedWorkspaces)) {
            this.workspaces = services.prefetchedWorkspaces;
            this.isLoading = false;
            this.render();
        } else {
            this.render();
            void this.loadWorkspaces().then(() => {
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
                    workspaceService = service;
                    this.services.workspaceService = workspaceService;
                }
            } catch {
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
            this.projectsManager.renderProjects(this.container);
            return;
        }

        if (this.currentView === 'project-detail') {
            this.projectsManager.renderProjectDetail(this.container);
            return;
        }

        if (this.currentView === 'task-detail') {
            this.projectsManager.renderTaskDetail(this.container);
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
        this.projectsManager.resetState();

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
            getTaskService: () => this.projectsManager.getTaskService(),
            onRefreshProjects: () => this.projectsManager.refreshProjects(),
            onOpenProjectDetail: (project) => { void this.openProjectDetailAndRender(project); },
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
            const workspaceId = this.currentWorkspace.id;
            if (!workspaceId) {
                return null;
            }

            if (existingIndex >= 0) {
                await this.services.workspaceService.updateWorkspace(
                    workspaceId,
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

        const confirmed = await this.confirmDeleteWorkspace();
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

    private async confirmDeleteWorkspace(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const modal = new WorkspaceDeleteConfirmModal(
                this.services.app,
                this.currentWorkspace?.name || 'Workspace',
                resolve
            );
            modal.open();
        });
    }

    // --- Projects (delegated to ProjectsManagerView) ---

    private async openProjectsPage(): Promise<void> {
        const success = await this.projectsManager.openProjectsPage();
        if (success) {
            this.currentView = 'projects';
            this.render();
        }
    }

    private async openProjectDetailAndRender(project: ProjectMetadata): Promise<void> {
        await this.projectsManager.openProjectDetail(project);
        this.currentView = 'project-detail';
        this.render();
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
        this.saveTimeout = setTimeout(() => {
            void this.saveCurrentWorkspace();
        }, 500);
    }

    destroy(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.detailRenderer.destroyForm();
    }
}

class WorkspaceDeleteConfirmModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private readonly workspaceName: string,
        private readonly onResolve: (confirmed: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Delete workspace?' });
        contentEl.createEl('p', {
            text: `Delete workspace "${this.workspaceName}"? This cannot be undone.`,
            cls: 'setting-item-description'
        });

        const buttonRow = contentEl.createDiv('modal-button-container');

        new ButtonComponent(buttonRow)
            .setButtonText('Cancel')
            .onClick(() => {
                this.resolve(false);
                this.close();
            });

        new ButtonComponent(buttonRow)
            .setButtonText('Delete')
            .setCta()
            .onClick(() => {
                this.resolve(true);
                this.close();
            });
    }

    onClose(): void {
        this.resolve(false);
        this.contentEl.empty();
    }

    private resolve(confirmed: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.onResolve(confirmed);
    }
}
