/**
 * SettingsRouter - Manages navigation state for settings UI
 * Handles tab switching and list/detail view navigation
 */

export type SettingsTab = 'defaults' | 'workspaces' | 'prompts' | 'providers' | 'data' | 'getstarted';
export type SettingsView = 'list' | 'detail';

export interface RouterState {
    tab: SettingsTab;
    view: SettingsView;
    detailId?: string;  // workspace/prompt/provider ID when in detail view
}

export class SettingsRouter {
    private state: RouterState = { tab: 'defaults', view: 'list' };
    private listeners: Set<(state: RouterState) => void> = new Set();

    /**
     * Get current router state
     */
    getState(): RouterState {
        return { ...this.state };
    }

    /**
     * Switch to a different tab (resets to list view)
     */
    setTab(tab: SettingsTab): void {
        this.state = { tab, view: 'list', detailId: undefined };
        this.notify();
    }

    /**
     * Navigate to detail view for a specific item
     */
    showDetail(id: string): void {
        this.state = {
            ...this.state,
            view: 'detail',
            detailId: id
        };
        this.notify();
    }

    /**
     * Go back to list view (from detail view)
     */
    back(): void {
        this.state = {
            ...this.state,
            view: 'list',
            detailId: undefined
        };
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
    }
}
