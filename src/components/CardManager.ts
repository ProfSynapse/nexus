/**
 * Unified Card Manager Component
 * Generic card management system for agents, providers, and other card-based UIs
 */

import { ButtonComponent } from 'obsidian';
import { Card, CardAction, CardConfig } from './Card';

export interface CardItem {
    id: string;
    name: string;
    description?: string;
    isEnabled: boolean;
    /** Optional per-item override for toggle visibility */
    showToggle?: boolean;
    /** Optional per-item override for edit visibility */
    showEdit?: boolean;
    /** Optional CSS class applied to the card's root element */
    cssClass?: string;
    /** Optional per-card action buttons (e.g., install, download) */
    additionalActions?: CardAction[];
}

export interface CardManagerConfig<T extends CardItem> {
    containerEl: HTMLElement;
    title: string;
    addButtonText?: string;
    emptyStateText: string;
    items: T[];
    onAdd?: () => void;
    onToggle: (item: T, enabled: boolean) => void | Promise<void>;
    onEdit: (item: T) => void;
    onDelete?: (item: T) => void;
    showToggle?: boolean;
    showAddButton?: boolean;
}

export class CardManager<T extends CardItem> {
    private config: CardManagerConfig<T>;
    private cardsContainer!: HTMLElement;
    private cards: Map<string, Card> = new Map();

    constructor(config: CardManagerConfig<T>) {
        this.config = config;
        this.buildContent();
    }

    /**
     * Build the card manager content
     */
    private buildContent(): void {
        this.config.containerEl.empty();

        // Add button section (optional)
        if (this.config.onAdd && this.config.showAddButton !== false) {
            this.createAddButton();
        }

        // Cards container
        this.cardsContainer = this.config.containerEl.createDiv('card-manager-grid');
        this.refreshCards();
    }

    /**
     * Create the add button
     */
    private createAddButton(): void {
        const addButtonContainer = this.config.containerEl.createDiv('card-manager-add-button');
        const onAdd = this.config.onAdd;
        if (!onAdd) {
            return;
        }
        new ButtonComponent(addButtonContainer)
            .setButtonText(this.config.addButtonText ?? '')
            .setCta()
            .onClick(() => onAdd());
    }

    /**
     * Refresh the cards display
     */
    public refreshCards(): void {
        this.cardsContainer.empty();
        this.cards.clear();

        if (this.config.items.length === 0) {
            this.cardsContainer.createDiv('card-manager-empty')
                .setText(this.config.emptyStateText);
            return;
        }

        this.config.items.forEach(item => this.createCard(item));
    }

    /**
     * Create a card for a single item
     */
    private createCard(item: T): void {
        const showToggle = item.showToggle ?? this.config.showToggle !== false;
        const showEdit = item.showEdit ?? true;
        const onDelete = this.config.onDelete;
        const cardConfig: CardConfig = {
            title: item.name,
            description: item.description || '',
            isEnabled: item.isEnabled,
            showToggle,
            onToggle: (enabled: boolean) => {
                // Update the item's enabled state BEFORE calling the callback
                // This prevents race conditions where refreshCards() uses stale data
                item.isEnabled = enabled;
                void this.config.onToggle(item, enabled);
                // Don't call refreshCards() - the toggle already reflects the new state
                // and the item is already updated in place
            },
            onEdit: showEdit ? () => this.config.onEdit(item) : undefined,
            onDelete: onDelete ? () => onDelete(item) : undefined,
            additionalActions: item.additionalActions
        };

        const card = new Card(this.cardsContainer, cardConfig);
        if (item.cssClass) {
            card.getElement().addClass(item.cssClass);
        }
        this.cards.set(item.id, card);
    }

    /**
     * Update the items and refresh display
     */
    public updateItems(items: T[]): void {
        this.config.items = items;
        this.refreshCards();
    }

    /**
     * Get a card by item ID
     */
    public getCard(itemId: string): Card | undefined {
        return this.cards.get(itemId);
    }
}
