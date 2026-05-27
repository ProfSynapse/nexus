/**
 * StatesSectionRenderer — Renders the "States" management section inside the
 * workspace detail view. Mirrors the renderProjectsSection pattern in
 * WorkspaceDetailRenderer.
 *
 * UI surface (workspace-scoped):
 * - List all states for the workspace (with Show archived toggle)
 * - Edit (rename + description) via modal
 * - Archive / Restore (reversible)
 * - Delete (permanent, with confirmation)
 *
 * The renderer is stateless beyond an in-memory cache of fetched states and
 * the "show archived" toggle. Data CRUD is delegated to the injected
 * `StatesSectionService` so this file stays free of storage-adapter and
 * MemoryService coupling.
 */

import { App, ButtonComponent, Component, Modal, Notice, TextAreaComponent, TextComponent, ToggleComponent, setIcon } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { ConfirmModal } from '../../settings/components/ConfirmModal';

/**
 * State summary shown in the list. Matches the projection returned by
 * MemoryService.getStates(workspaceId) item shape.
 */
export interface StateSummary {
    id: string;
    name: string;
    description?: string;
    sessionId?: string;
    workspaceId?: string;
    created: number;
    tags?: string[];
    isArchived?: boolean;
}

/**
 * Patch shape accepted by updateState. Optional fields = "leave alone".
 */
export interface StateUpdatePatch {
    name?: string;
    description?: string;
    tags?: string[];
}

/**
 * Service contract the StatesSectionRenderer depends on. Implemented in
 * WorkspacesTab by adapting MemoryService + HybridStorageAdapter.
 */
export interface StatesSectionService {
    listStates(workspaceId: string, includeArchived: boolean): Promise<StateSummary[]>;
    updateState(workspaceId: string, sessionId: string, stateId: string, patch: StateUpdatePatch): Promise<void>;
    archiveState(workspaceId: string, sessionId: string, stateId: string, restore: boolean): Promise<void>;
    deleteState(workspaceId: string, sessionId: string, stateId: string): Promise<void>;
}

export class StatesSectionRenderer {
    private container?: HTMLElement;
    private listContainer?: HTMLElement;
    private workspaceId?: string;
    private includeArchived = false;
    private cachedStates: StateSummary[] = [];
    private isLoading = false;
    private loadError: string | null = null;

    constructor(
        private app: App,
        private service: StatesSectionService,
        private component?: Component
    ) {}

    /**
     * Render the States section into the given container.
     * Idempotent — clears prior contents and re-renders.
     */
    render(container: HTMLElement, workspaceId: string | undefined): void {
        this.container = container;
        this.workspaceId = workspaceId;
        container.empty();

        if (!workspaceId) {
            new BoxedSection(container, {
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

        new BoxedSection(container, {
            title: 'States',
            unbounded: true,
            toolbar: (toolbar) => {
                const archivedLabel = toolbar.createDiv('nexus-states-archived-toggle');
                archivedLabel.createSpan({ text: 'Show archived', cls: 'nexus-states-toolbar-label' });
                new ToggleComponent(archivedLabel)
                    .setValue(this.includeArchived)
                    .onChange((value) => {
                        this.includeArchived = value;
                        void this.loadAndRender();
                    });

                new ButtonComponent(toolbar)
                    .setButtonText('Refresh')
                    .onClick(() => { void this.loadAndRender(); });
            },
            body: (body) => {
                body.createEl('p', {
                    text: 'Snapshots of workspace context that can be resumed later. Edit, archive, or delete states here.',
                    cls: 'nexus-form-hint'
                });
                this.listContainer = body.createDiv('nexus-states-list');
            }
        }, this.component);

        void this.loadAndRender();
    }

    /**
     * Re-fetch the workspace's states and re-render the list area.
     * Errors are surfaced inline (no Notice spam from background refreshes).
     */
    private async loadAndRender(): Promise<void> {
        if (!this.workspaceId || !this.listContainer) return;

        this.isLoading = true;
        this.loadError = null;
        this.renderList();

        try {
            this.cachedStates = await this.service.listStates(this.workspaceId, this.includeArchived);
        } catch (error) {
            console.error('[StatesSectionRenderer] Failed to load states:', error);
            this.loadError = 'Failed to load states.';
            this.cachedStates = [];
        } finally {
            this.isLoading = false;
            this.renderList();
        }
    }

    private renderList(): void {
        const list = this.listContainer;
        if (!list) return;
        list.empty();

        if (this.isLoading) {
            list.createEl('p', {
                text: 'Loading states...',
                cls: 'nexus-loading-message'
            });
            return;
        }

        if (this.loadError) {
            list.createEl('p', {
                text: this.loadError,
                cls: 'nexus-form-hint nexus-states-error'
            });
            return;
        }

        if (this.cachedStates.length === 0) {
            list.createEl('p', {
                text: this.includeArchived
                    ? 'No states yet.'
                    : 'No active states. Toggle "Show archived" to see archived states.',
                cls: 'nexus-form-hint'
            });
            return;
        }

        const sorted = [...this.cachedStates].sort((a, b) => b.created - a.created);
        for (const state of sorted) {
            this.renderStateRow(list, state);
        }
    }

    private renderStateRow(container: HTMLElement, state: StateSummary): void {
        const row = container.createDiv('nexus-states-row');
        if (state.isArchived) {
            row.addClass('nexus-states-row--archived');
        }

        const main = row.createDiv('nexus-states-row-main');
        const titleEl = main.createDiv('nexus-states-row-title');
        titleEl.setText(state.name || 'Untitled state');
        if (state.isArchived) {
            titleEl.createSpan({ text: 'Archived', cls: 'nexus-states-archived-badge' });
        }

        const meta = main.createDiv('nexus-states-row-meta');
        meta.setText(this.formatMeta(state));

        if (state.description) {
            const desc = main.createDiv('nexus-states-row-description');
            desc.setText(state.description);
        }

        const actions = row.createDiv('nexus-states-row-actions');

        // Edit
        const editBtn = actions.createEl('button', {
            cls: 'clickable-icon nexus-states-action-btn',
            attr: { 'aria-label': 'Edit state' }
        });
        setIcon(editBtn, 'edit');
        this.safeRegisterDomEvent(editBtn, 'click', () => this.openEditModal(state));

        // Archive / Restore
        const archiveBtn = actions.createEl('button', {
            cls: 'clickable-icon nexus-states-action-btn',
            attr: { 'aria-label': state.isArchived ? 'Restore state' : 'Archive state' }
        });
        setIcon(archiveBtn, state.isArchived ? 'archive-restore' : 'archive');
        this.safeRegisterDomEvent(archiveBtn, 'click', () => { void this.toggleArchive(state); });

        // Delete
        const deleteBtn = actions.createEl('button', {
            cls: 'clickable-icon nexus-states-action-btn nexus-states-delete-btn',
            attr: { 'aria-label': 'Delete state' }
        });
        setIcon(deleteBtn, 'trash');
        this.safeRegisterDomEvent(deleteBtn, 'click', () => { void this.confirmAndDelete(state); });
    }

    private formatMeta(state: StateSummary): string {
        const parts: string[] = [];
        if (state.created) {
            parts.push(new Date(state.created).toLocaleString());
        }
        if (state.tags && state.tags.length > 0) {
            parts.push(state.tags.map(t => `#${t}`).join(' '));
        }
        return parts.join(' • ');
    }

    private openEditModal(state: StateSummary): void {
        if (!this.workspaceId) return;
        const sessionId = state.sessionId;
        if (!sessionId) {
            new Notice('Cannot edit state: missing sessionId');
            return;
        }
        const workspaceId = this.workspaceId;
        const modal = new StateEditModal(this.app, state, async (patch) => {
            try {
                await this.service.updateState(workspaceId, sessionId, state.id, patch);
                new Notice('State updated');
                await this.loadAndRender();
            } catch (error) {
                console.error('[StatesSectionRenderer] Failed to update state:', error);
                new Notice('Failed to update state');
            }
        });
        modal.open();
    }

    private async toggleArchive(state: StateSummary): Promise<void> {
        if (!this.workspaceId) return;
        const sessionId = state.sessionId;
        if (!sessionId) {
            new Notice('Cannot archive state: missing sessionId');
            return;
        }
        const restore = !!state.isArchived;

        // Confirm on archive (going to archived); restore is a one-click reversal,
        // no confirmation needed.
        if (!restore) {
            const confirmed = await this.confirmArchive(state.name || 'Untitled state');
            if (!confirmed) return;
        }

        try {
            await this.service.archiveState(this.workspaceId, sessionId, state.id, restore);
            new Notice(restore ? 'State restored' : 'State archived');
            await this.loadAndRender();
        } catch (error) {
            console.error('[StatesSectionRenderer] Failed to archive state:', error);
            new Notice('Failed to archive state');
        }
    }

    private confirmArchive(stateName: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let confirmed = false;
            const modal = new ConfirmModal(this.app, {
                variant: 'archive',
                title: 'Archive state?',
                body: `Archive state "${stateName}"? You can restore it later from this list.`,
                onConfirm: () => { confirmed = true; }
            });
            modal.onClose = () => {
                modal.contentEl.empty();
                resolve(confirmed);
            };
            modal.open();
        });
    }

    private async confirmAndDelete(state: StateSummary): Promise<void> {
        if (!this.workspaceId) return;
        const sessionId = state.sessionId;
        if (!sessionId) {
            new Notice('Cannot delete state: missing sessionId');
            return;
        }
        const workspaceId = this.workspaceId;
        const confirmed = await this.confirmDelete(state.name || 'Untitled state');
        if (!confirmed) return;
        try {
            await this.service.deleteState(workspaceId, sessionId, state.id);
            new Notice('State deleted');
            await this.loadAndRender();
        } catch (error) {
            console.error('[StatesSectionRenderer] Failed to delete state:', error);
            new Notice('Failed to delete state');
        }
    }

    private confirmDelete(stateName: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const modal = new StateDeleteConfirmModal(this.app, stateName, resolve);
            modal.open();
        });
    }

    private safeRegisterDomEvent<K extends keyof HTMLElementEventMap>(
        el: HTMLElement,
        type: K,
        handler: (ev: HTMLElementEventMap[K]) => void
    ): void {
        if (this.component) {
            this.component.registerDomEvent(el, type, handler);
        } else {
            el.addEventListener(type, handler);
        }
    }
}

/**
 * Modal for renaming a state and editing its description.
 * Mirrors the WorkspaceDeleteConfirmModal modal style used elsewhere in
 * WorkspacesTab.
 */
class StateEditModal extends Modal {
    private resolved = false;
    private nameValue: string;
    private descriptionValue: string;

    constructor(
        app: App,
        private readonly state: StateSummary,
        private readonly onSave: (patch: StateUpdatePatch) => Promise<void>
    ) {
        super(app);
        this.nameValue = state.name || '';
        this.descriptionValue = state.description || '';
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('nexus-state-edit-modal');

        contentEl.createEl('h2', { text: 'Edit state' });

        contentEl.createEl('label', {
            text: 'Name',
            cls: 'nexus-state-edit-label'
        });
        const nameInput = new TextComponent(contentEl);
        nameInput.setValue(this.nameValue);
        nameInput.inputEl.addClass('nexus-state-edit-input');
        nameInput.onChange((value) => {
            this.nameValue = value;
        });

        contentEl.createEl('label', {
            text: 'Description',
            cls: 'nexus-state-edit-label'
        });
        const descInput = new TextAreaComponent(contentEl);
        descInput.setValue(this.descriptionValue);
        descInput.inputEl.addClass('nexus-state-edit-textarea');
        descInput.onChange((value) => {
            this.descriptionValue = value;
        });

        const buttonRow = contentEl.createDiv('modal-button-container');

        new ButtonComponent(buttonRow)
            .setButtonText('Cancel')
            .onClick(() => {
                this.resolved = true;
                this.close();
            });

        new ButtonComponent(buttonRow)
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
                if (this.resolved) return;
                this.resolved = true;
                const patch = this.buildPatch();
                this.close();
                void this.onSave(patch);
            });
    }

    private buildPatch(): StateUpdatePatch {
        const patch: StateUpdatePatch = {};
        const trimmedName = this.nameValue.trim();
        if (trimmedName && trimmedName !== (this.state.name || '')) {
            patch.name = trimmedName;
        }
        const trimmedDesc = this.descriptionValue;
        if (trimmedDesc !== (this.state.description || '')) {
            patch.description = trimmedDesc;
        }
        return patch;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Confirmation modal for permanent state deletion.
 * Mirrors WorkspaceDeleteConfirmModal in WorkspacesTab.ts.
 */
class StateDeleteConfirmModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private readonly stateName: string,
        private readonly onResolve: (confirmed: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Delete state?' });
        contentEl.createEl('p', {
            text: `Delete state "${this.stateName}"? This cannot be undone.`,
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
            .setWarning()
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
