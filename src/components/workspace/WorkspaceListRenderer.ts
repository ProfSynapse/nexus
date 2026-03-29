/**
 * WorkspaceListRenderer — Renders the workspace list view with card grid.
 * Extracted from WorkspacesTab to keep the tab under 600 lines.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { CardItem } from '../CardManager';
import { SearchableCardManager } from '../SearchableCardManager';
import { ProjectWorkspace } from '../../database/workspace-types';

class ConfirmWorkspaceDeleteModal extends Modal {
    constructor(
        app: App,
        private readonly message: string,
        private readonly onConfirm: () => void,
        private readonly onCancel: () => void
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Confirm action' });
        contentEl.createEl('p', { text: this.message });

        new Setting(contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => {
                this.onCancel();
                this.close();
            }))
            .addButton((button) => button.setButtonText('Delete').setWarning().onClick(() => {
                this.onConfirm();
                this.close();
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export interface WorkspaceListCallbacks {
    onCreateNew: () => void;
    onEdit: (workspaceId: string) => void;
    onToggle: (workspaceId: string, enabled: boolean) => Promise<void>;
    onDelete: (workspaceId: string, name: string) => Promise<void>;
}

export class WorkspaceListRenderer {
    private cardManager?: SearchableCardManager<CardItem>;

    constructor(private readonly app: App) {}

    private confirmDelete(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            new ConfirmWorkspaceDeleteModal(this.app, message, () => resolve(true), () => resolve(false)).open();
        });
    }

    render(
        container: HTMLElement,
        workspaces: ProjectWorkspace[],
        isLoading: boolean,
        serviceAvailable: boolean,
        callbacks: WorkspaceListCallbacks
    ): void {
        // Header
        container.createEl('h3', { text: 'Workspaces' });
        container.createEl('p', {
            text: 'Organize your vault into focused workspaces',
            cls: 'setting-item-description'
        });

        if (isLoading) {
            this.renderLoadingSkeleton(container);
            return;
        }

        if (!serviceAvailable) {
            container.createEl('p', {
                text: 'Workspace service is initializing...',
                cls: 'nexus-loading-message'
            });
            return;
        }

        const cardItems: CardItem[] = workspaces
            .filter(workspace => workspace && workspace.id)
            .map(workspace => ({
                id: workspace.id,
                name: workspace.name || 'Untitled Workspace',
                description: workspace.rootFolder || '/',
                isEnabled: workspace.isActive ?? true
            }));

        this.cardManager = new SearchableCardManager<CardItem>({
            containerEl: container,
            cardManagerConfig: {
                title: 'Workspaces',
                addButtonText: '+ New Workspace',
                emptyStateText: 'No workspaces yet. Create one to get started.',
                showToggle: true,
                onAdd: () => callbacks.onCreateNew(),
                onToggle: (item, enabled) => {
                    void callbacks.onToggle(item.id, enabled);
                },
                onEdit: (item) => {
                    callbacks.onEdit(item.id);
                },
                onDelete: (item) => {
                    void (async () => {
                        const confirmed = await this.confirmDelete(`Delete workspace "${item.name}"? This cannot be undone.`);
                        if (!confirmed) {
                            return;
                        }

                        try {
                            await callbacks.onDelete(item.id, item.name);
                            new Notice('Workspace deleted');
                        } catch (error) {
                            console.error('[WorkspaceListRenderer] Failed to delete workspace:', error);
                            new Notice('Failed to delete workspace');
                        }
                    })();
                }
            },
            items: cardItems,
            search: {
                placeholder: 'Search workspaces...'
            }
        });
    }

    updateItems(workspaces: ProjectWorkspace[]): void {
        this.cardManager?.updateItems(workspaces.map(w => ({
            id: w.id,
            name: w.name || 'Untitled Workspace',
            description: w.rootFolder || '/',
            isEnabled: w.isActive ?? true
        })));
    }

    private renderLoadingSkeleton(container: HTMLElement): void {
        const grid = container.createDiv('card-manager-grid');
        for (let i = 0; i < 3; i++) {
            const skeleton = grid.createDiv('nexus-skeleton-card');
            skeleton.createDiv('nexus-skeleton-title');
            skeleton.createDiv('nexus-skeleton-description');
            skeleton.createDiv('nexus-skeleton-actions');
        }
    }
}
