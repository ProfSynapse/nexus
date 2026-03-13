/**
 * SearchableCardManager - Composition wrapper around CardManager
 * Adds search filtering and optional group headers on top of CardManager.
 */

import { TextComponent } from 'obsidian';
import { CardManager, CardManagerConfig, CardItem } from './CardManager';

export interface CardSearchConfig<T extends CardItem> {
    /** Placeholder text for search input */
    placeholder: string;
    /** Pure filter function — receives item and lowercase query, returns boolean. Defaults to name+description match. */
    filterFn?: (item: T, query: string) => boolean;
    /** Hide search when total items below this threshold. Default: 5 */
    minItemsForSearch?: number;
}

export interface CardGroup<T extends CardItem> {
    /** Group header text (e.g., "LOCAL PROVIDERS", "INSTALLED APPS") */
    title: string;
    /** Items belonging to this group */
    items: T[];
}

export interface SearchableCardManagerConfig<T extends CardItem> {
    containerEl: HTMLElement;
    /** CardManager config fields (title, addButtonText, etc.) — spread into CardManager */
    cardManagerConfig: Omit<CardManagerConfig<T>, 'containerEl' | 'items'>;
    /** All items (ungrouped mode) — mutually exclusive with groups */
    items?: T[];
    /** Grouped items — mutually exclusive with items */
    groups?: CardGroup<T>[];
    /** Search configuration — omit to disable search */
    search?: CardSearchConfig<T>;
}

/**
 * Default filter — case-insensitive substring match on name + description.
 * Exported for independent unit testing.
 */
export function filterItems<T extends CardItem>(
    items: T[],
    query: string,
    filterFn?: (item: T, query: string) => boolean
): T[] {
    if (!query) {
        return items;
    }
    const q = query.toLowerCase();
    const fn = filterFn ?? defaultFilter;
    return items.filter(item => fn(item, q));
}

/**
 * Default filter function — case-insensitive substring match on name + description.
 */
function defaultFilter<T extends CardItem>(item: T, query: string): boolean {
    return item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false);
}

export class SearchableCardManager<T extends CardItem> {
    private config: SearchableCardManagerConfig<T>;
    private searchInput: TextComponent | null = null;
    private query = '';
    private cardManagers: CardManager<T>[] = [];
    private groupContainers: HTMLElement[] = [];
    private contentEl: HTMLElement;

    constructor(config: SearchableCardManagerConfig<T>) {
        this.config = config;
        this.contentEl = config.containerEl;
        this.build();
    }

    private build(): void {
        this.buildSearchInput();

        if (this.config.groups) {
            this.buildGrouped(this.config.groups);
        } else if (this.config.items) {
            this.buildUngrouped(this.config.items);
        }
    }

    private buildSearchInput(): void {
        const allItems = this.getAllItems();
        const minItems = this.config.search?.minItemsForSearch ?? 5;

        if (!this.config.search || allItems.length < minItems) {
            return;
        }

        const searchContainer = this.contentEl.createDiv('searchable-card-manager-search');
        this.searchInput = new TextComponent(searchContainer);
        this.searchInput.setPlaceholder(this.config.search.placeholder);
        this.searchInput.inputEl.setAttribute('aria-label', this.config.search.placeholder);
        this.searchInput.inputEl.addClass('searchable-card-manager-input');
        this.searchInput.onChange(value => {
            this.query = value;
            this.applyFilter();
        });
    }

    private buildUngrouped(items: T[]): void {
        const filtered = this.getFilteredItems(items);
        const container = this.contentEl.createDiv();
        const manager = new CardManager<T>({
            ...this.config.cardManagerConfig,
            containerEl: container,
            items: filtered
        });
        this.cardManagers.push(manager);
    }

    private buildGrouped(groups: CardGroup<T>[]): void {
        for (const group of groups) {
            const filtered = this.getFilteredItems(group.items);
            const groupEl = this.contentEl.createDiv('searchable-card-manager-group');

            const header = groupEl.createDiv('nexus-provider-group-title');
            header.setText(group.title);

            const cardContainer = groupEl.createDiv();
            const manager = new CardManager<T>({
                ...this.config.cardManagerConfig,
                containerEl: cardContainer,
                items: filtered
            });

            this.groupContainers.push(groupEl);
            this.cardManagers.push(manager);

            groupEl.toggleClass('searchable-card-manager-group--hidden', filtered.length === 0);
        }
    }

    private applyFilter(): void {
        if (this.config.groups) {
            this.config.groups.forEach((group, index) => {
                const filtered = this.getFilteredItems(group.items);
                this.cardManagers[index].updateItems(filtered);

                if (this.groupContainers[index]) {
                    this.groupContainers[index].toggleClass(
                        'searchable-card-manager-group--hidden',
                        filtered.length === 0
                    );
                }
            });
        } else if (this.config.items) {
            const filtered = this.getFilteredItems(this.config.items);
            if (this.cardManagers[0]) {
                this.cardManagers[0].updateItems(filtered);
            }
        }
    }

    private getFilteredItems(items: T[]): T[] {
        return filterItems(items, this.query, this.config.search?.filterFn);
    }

    private getAllItems(): T[] {
        if (this.config.groups) {
            return this.config.groups.flatMap(g => g.items);
        }
        return this.config.items ?? [];
    }

    /**
     * Update all items and re-render. For ungrouped mode.
     */
    public updateItems(items: T[]): void {
        this.config.items = items;
        this.rebuild();
    }

    /**
     * Update groups and re-render. For grouped mode.
     */
    public updateGroups(groups: CardGroup<T>[]): void {
        this.config.groups = groups;
        this.rebuild();
    }

    private rebuild(): void {
        this.contentEl.empty();
        this.cardManagers = [];
        this.groupContainers = [];
        this.searchInput = null;
        this.build();
    }
}
