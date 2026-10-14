/**
 * SettingsRouter - Manages navigation state for settings UI
 * Handles tab switching and list/detail view navigation
 */

export type SettingsTab = 'defaults' | 'workspaces' | 'instructions' | 'prompts' | 'providers' | 'remote-agents' | 'apps' | 'data';
export type SettingsView = 'list' | 'detail';
/** In-tab pages that replace the Get started row, tab strip and panes while open. */
export type SettingsPage = 'get-started' | 'get-started-chat' | 'get-started-agents';

export interface RouterState {
    tab: SettingsTab;
    view: SettingsView;
    detailId?: string;  // workspace/prompt/provider ID when in detail view
    page?: SettingsPage;
}

/** Each page's parent; a page with no entry goes back to the tab list. */
const PAGE_PARENT: Partial<Record<SettingsPage, SettingsPage>> = {
    'get-started-chat': 'get-started',
    'get-started-agents': 'get-started'
};

export class SettingsRouter {
    private state: RouterState = { tab: 'defaults', view: 'list' };
    private listeners: Set<(state: RouterState) => void> = new Set();
    private navigationGuard?: (next: RouterState) => boolean;

    /**
     * Get current router state
     */
    getState(): RouterState {
        return { ...this.state };
    }

    /**
     * Switch to a different tab (resets to list view and closes any page)
     */
    setTab(tab: SettingsTab): void {
        this.navigate({ tab: tab === 'prompts' ? 'instructions' : tab, view: 'list', detailId: undefined, page: undefined });
    }

    /** Open an in-tab page. The tab underneath is kept for when the page closes. */
    openPage(page: SettingsPage): void {
        this.navigate({ ...this.state, page });
    }

    /** Close any open page and return to the tab list on the same tab. */
    closePage(): void {
        this.navigate({ ...this.state, page: undefined });
    }

    isPageOpen(): boolean {
        return this.state.page !== undefined;
    }

    /**
     * Navigate to detail view for a specific item
     */
    showDetail(id: string): void {
        this.navigate({
            ...this.state,
            view: 'detail',
            detailId: id
        });
    }

    /**
     * Go back one level: from a page to its parent page (or the tab list),
     * otherwise from detail view to list view.
     */
    back(): void {
        if (this.state.page) {
            this.navigate({ ...this.state, page: PAGE_PARENT[this.state.page] });
            return;
        }
        this.navigate({
            ...this.state,
            view: 'list',
            detailId: undefined
        });
    }

    /** An owning editor may prevent navigation while it has unsaved changes. */
    setNavigationGuard(guard: (next: RouterState) => boolean): () => void {
        this.navigationGuard = guard;
        return () => { if (this.navigationGuard === guard) this.navigationGuard = undefined; };
    }

    private navigate(next: RouterState): void {
        if (!this.navigationGuard || this.navigationGuard(next)) this.state = next;
        this.notify();
    }

    /**
     * Check if currently in detail view
     */
    isDetailView(): boolean {
        return this.state.view === 'detail';
    }

    /**
     * Subscribe to navigation changes
     */
    onNavigate(callback: (state: RouterState) => void): () => void {
        this.listeners.add(callback);
        // Return unsubscribe function
        return () => this.listeners.delete(callback);
    }

    /**
     * Notify all listeners of state change
     */
    private notify(): void {
        const currentState = this.getState();
        this.listeners.forEach(callback => callback(currentState));
    }

    /**
     * Cleanup - remove all listeners
     */
    destroy(): void {
        this.listeners.clear();
        this.navigationGuard = undefined;
    }
}
