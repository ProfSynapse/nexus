/**
 * PromptsTab - Custom prompts list and detail view
 *
 * Features:
 * - List view showing all custom prompts with status badges
 * - Detail view for editing prompt configuration
 * - Create/Edit/Delete prompts
 * - Auto-save on all changes
 */

import { Notice, TextComponent, TextAreaComponent, ButtonComponent } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { BackButton } from '../components/BackButton';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { CardManager, CardItem } from '../../components/CardManager';

export interface PromptsTabServices {
    customPromptStorage?: CustomPromptStorageService;
}

type PromptsView = 'list' | 'detail';

export class PromptsTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private services: PromptsTabServices;
    private prompts: CustomPrompt[] = [];
    private currentPrompt: Partial<CustomPrompt> | null = null;
    private currentView: PromptsView = 'list';
    private isNewPrompt: boolean = false;

    // Auto-save debounce
    private saveTimeout?: ReturnType<typeof setTimeout>;

    // Card manager for list view
    private cardManager?: CardManager<CardItem>;

    constructor(
        container: HTMLElement,
        router: SettingsRouter,
        services: PromptsTabServices
    ) {
        this.container = container;
        this.router = router;
        this.services = services;

        this.loadPrompts();
        this.render();
    }

    /**
     * Load prompts from storage service
     */
    private loadPrompts(): void {
        if (!this.services.customPromptStorage) return;
        this.prompts = this.services.customPromptStorage.getAllPrompts();
    }

    /**
     * Main render method
     */
    render(): void {
        this.container.empty();

        const state = this.router.getState();

        // Check router state for navigation
        if (state.view === 'detail' && state.detailId) {
            this.currentView = 'detail';
            const prompt = this.prompts.find(p => p.id === state.detailId);
            if (prompt) {
                this.currentPrompt = { ...prompt };
                this.isNewPrompt = false;
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

        // Header
        this.container.createEl('h3', { text: 'Custom Prompts' });
        this.container.createEl('p', {
            text: 'Create specialized prompts with custom system instructions',
            cls: 'setting-item-description'
        });

        // Check if service is available
        if (!this.services.customPromptStorage) {
            this.container.createEl('p', {
                text: 'Prompt service is initializing...',
                cls: 'nexus-loading-message'
            });
            return;
        }

        // Convert prompts to CardItem format
        const cardItems: CardItem[] = this.prompts.map(prompt => ({
            id: prompt.id,
            name: prompt.name,
            description: prompt.description || 'No description',
            isEnabled: prompt.isEnabled
        }));

        // Create card manager
        this.cardManager = new CardManager({
            containerEl: this.container,
            title: 'Custom Prompts',
            addButtonText: '+ New Prompt',
            emptyStateText: 'No custom prompts yet. Create one to get started.',
            items: cardItems,
            showToggle: true,
            onAdd: () => this.createNewPrompt(),
            onToggle: async (item, enabled) => {
                const prompt = this.prompts.find(p => p.id === item.id);
                if (prompt && this.services.customPromptStorage) {
                    await this.services.customPromptStorage.updatePrompt(item.id, { isEnabled: enabled });
                    prompt.isEnabled = enabled;
                }
            },
            onEdit: (item) => {
                this.router.showDetail(item.id);
            },
            onDelete: async (item) => {
                const confirmed = confirm(`Delete prompt "${item.name}"? This cannot be undone.`);
                if (!confirmed) return;

                try {
                    if (this.services.customPromptStorage) {
                        await this.services.customPromptStorage.deletePrompt(item.id);
                        this.prompts = this.prompts.filter(p => p.id !== item.id);
                        this.cardManager?.updateItems(this.prompts.map(p => ({
                            id: p.id,
                            name: p.name,
                            description: p.description || 'No description',
                            isEnabled: p.isEnabled
                        })));
                        new Notice('Prompt deleted');
                    }
                } catch (error) {
                    console.error('[PromptsTab] Failed to delete prompt:', error);
                    new Notice('Failed to delete prompt');
                }
            }
        });
    }

    /**
     * Render detail view
     */
    private renderDetail(): void {
        this.container.empty();

        const prompt = this.currentPrompt;
        if (!prompt) {
            this.router.back();
            return;
        }

        // Back button
        new BackButton(this.container, 'Back to Prompts', () => {
            this.saveCurrentPrompt();
            this.router.back();
        });

        // Form container with modern stacked layout
        const form = this.container.createDiv('nexus-modern-form');

        // Name field
        const nameField = form.createDiv('nexus-form-field');
        nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
        const nameInput = new TextComponent(nameField);
        nameInput.setPlaceholder('e.g., Code Reviewer');
        nameInput.setValue(prompt.name || '');
        nameInput.onChange((value) => {
            prompt.name = value;
            this.debouncedSave();
        });

        // Description field
        const descField = form.createDiv('nexus-form-field');
        descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        descField.createEl('span', {
            text: 'A brief description of what this prompt does',
            cls: 'nexus-form-hint'
        });
        const descInput = new TextAreaComponent(descField);
        descInput.setPlaceholder('e.g., Reviews code for best practices and potential issues');
        descInput.setValue(prompt.description || '');
        descInput.onChange((value) => {
            prompt.description = value;
            this.debouncedSave();
        });

        // System Prompt field
        const promptField = form.createDiv('nexus-form-field');
        promptField.createEl('label', { text: 'System Prompt', cls: 'nexus-form-label' });
        promptField.createEl('span', {
            text: 'Instructions that define this prompt\'s behavior and expertise',
            cls: 'nexus-form-hint'
        });
        const promptInput = new TextAreaComponent(promptField);
        promptInput.setPlaceholder('You are an expert code reviewer. When reviewing code, focus on...');
        promptInput.setValue(prompt.prompt || '');
        promptInput.onChange((value) => {
            prompt.prompt = value;
            this.debouncedSave();
        });
        // Make the system prompt textarea larger
        promptInput.inputEl.rows = 8;
        promptInput.inputEl.addClass('nexus-form-textarea-large');

        // Action buttons
        const actions = form.createDiv('nexus-form-actions');

        new ButtonComponent(actions)
            .setButtonText('Save')
            .setCta()
            .onClick(async () => {
                // Cancel any pending debounced save to prevent double-save
                if (this.saveTimeout) {
                    clearTimeout(this.saveTimeout);
                    this.saveTimeout = undefined;
                }
                await this.saveCurrentPrompt();
                new Notice('Prompt saved');
                this.router.back();
            });

        if (!this.isNewPrompt && prompt.id) {
            new ButtonComponent(actions)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => this.deleteCurrentPrompt());
        }
    }

    /**
     * Create a new prompt
     */
    private createNewPrompt(): void {
        this.currentPrompt = {
            name: '',
            description: '',
            prompt: '',
            isEnabled: true
        };
        this.isNewPrompt = true;
        this.currentView = 'detail';
        this.renderDetail();
    }

    /**
     * Save the current prompt
     */
    private async saveCurrentPrompt(): Promise<void> {
        if (!this.currentPrompt || !this.services.customPromptStorage) return;

        // Validate required fields
        if (!this.currentPrompt.name?.trim()) {
            new Notice('Prompt name is required');
            return;
        }

        try {
            if (this.isNewPrompt) {
                // Create new prompt
                const created = await this.services.customPromptStorage.createPrompt({
                    name: this.currentPrompt.name,
                    description: this.currentPrompt.description || '',
                    prompt: this.currentPrompt.prompt || '',
                    isEnabled: this.currentPrompt.isEnabled ?? true
                });
                this.prompts.push(created);
                this.currentPrompt = created;
                this.isNewPrompt = false;
            } else if (this.currentPrompt.id) {
                // Update existing prompt
                await this.services.customPromptStorage.updatePrompt(
                    this.currentPrompt.id,
                    {
                        name: this.currentPrompt.name,
                        description: this.currentPrompt.description,
                        prompt: this.currentPrompt.prompt,
                        isEnabled: this.currentPrompt.isEnabled
                    }
                );
                // Update local cache
                const index = this.prompts.findIndex(p => p.id === this.currentPrompt?.id);
                if (index >= 0) {
                    this.prompts[index] = this.currentPrompt as CustomPrompt;
                }
            }
        } catch (error) {
            console.error('[PromptsTab] Failed to save prompt:', error);
            new Notice(`Failed to save prompt: ${(error as Error).message}`);
        }
    }

    /**
     * Delete the current prompt
     */
    private async deleteCurrentPrompt(): Promise<void> {
        if (!this.currentPrompt?.id || !this.services.customPromptStorage) return;

        const confirmed = confirm(`Delete prompt "${this.currentPrompt.name}"? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await this.services.customPromptStorage.deletePrompt(this.currentPrompt.id);
            this.prompts = this.prompts.filter(p => p.id !== this.currentPrompt?.id);
            this.currentPrompt = null;
            this.router.back();
            new Notice('Prompt deleted');
        } catch (error) {
            console.error('[PromptsTab] Failed to delete prompt:', error);
            new Notice('Failed to delete prompt');
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
            this.saveCurrentPrompt();
        }, 500);
    }

    /**
     * Cleanup
     */
    destroy(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
    }
}
