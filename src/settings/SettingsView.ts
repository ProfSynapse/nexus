import { App, Plugin, PluginSettingTab, Setting, Notice, ButtonComponent, FileSystemAdapter } from 'obsidian';
import { Settings } from '../settings';
import { UnifiedTabs, UnifiedTabConfig } from '../components/UnifiedTabs';
import { SettingsRouter, RouterState, SettingsTab } from './SettingsRouter';
import { UpdateManager } from '../utils/UpdateManager';
import { supportsMCPBridge } from '../utils/platform';

// Type to access private method (should be refactored to make fetchLatestRelease public in UpdateManager)
type UpdateManagerWithFetchRelease = {
    fetchLatestRelease(): Promise<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>;
};

// Services
import { WorkspaceService } from '../services/WorkspaceService';
import { MemoryService } from '../agents/memoryManager/services/MemoryService';
import { CustomPromptStorageService } from '../agents/promptManager/services/CustomPromptStorageService';
import type { ServiceManager } from '../core/ServiceManager';

// Agents
import { SearchManagerAgent } from '../agents/searchManager/searchManager';
import { MemoryManagerAgent } from '../agents/memoryManager/memoryManager';

// Tab implementations
import { DefaultsTab } from './tabs/DefaultsTab';
import { WorkspacesTab } from './tabs/WorkspacesTab';
import { PromptsTab } from './tabs/PromptsTab';
import { ProvidersTab } from './tabs/ProvidersTab';
// GetStartedTab is dynamically imported (desktop-only, requires Node.js)
type GetStartedTabType = import('./tabs/GetStartedTab').GetStartedTab;
// import { DataTab } from './tabs/DataTab'; // TODO: Re-enable when Data tab is ready

/**
 * SettingsView - New unified settings interface with tab-based navigation
 * Replaces the accordion-based SettingsTab
 */
export class SettingsView extends PluginSettingTab {
    private settingsManager: Settings;
    private plugin: Plugin;

    // Services
    private memoryService: MemoryService | undefined;
    private workspaceService: WorkspaceService | undefined;
    private customPromptStorage: CustomPromptStorageService | undefined;

    // Agents
    private searchManager: SearchManagerAgent | undefined;
    private memoryManager: MemoryManagerAgent | undefined;

    // Managers
    private serviceManager: ServiceManager | undefined;
    private pluginLifecycleManager: any;

    // UI Components
    private tabs: UnifiedTabs | undefined;
    private router: SettingsRouter;
    private unsubscribeRouter: (() => void) | undefined;

    // Tab instances
    private defaultsTab: DefaultsTab | undefined;
    private workspacesTab: WorkspacesTab | undefined;
    private promptsTab: PromptsTab | undefined;
    private providersTab: ProvidersTab | undefined;
    private getStartedTab: GetStartedTabType | undefined;
    // private dataTab: DataTab | undefined; // TODO: Re-enable when Data tab is ready

    // Prefetched data cache
    private prefetchedWorkspaces: any[] | null = null;
    private isPrefetching: boolean = false;

    constructor(
        app: App,
        plugin: Plugin,
        settingsManager: Settings,
        services?: {
            workspaceService?: WorkspaceService;
            memoryService?: MemoryService;
        },
        searchManager?: SearchManagerAgent,
        memoryManager?: MemoryManagerAgent,
        serviceManager?: ServiceManager,
        pluginLifecycleManager?: any
    ) {
        super(app, plugin);
        this.plugin = plugin;
        this.settingsManager = settingsManager;

        // Initialize services
        if (services) {
            this.memoryService = services.memoryService;
            this.workspaceService = services.workspaceService;
        }

        // Store agent references
        this.searchManager = searchManager;
        this.memoryManager = memoryManager;

        // Store managers
        this.serviceManager = serviceManager;
        this.pluginLifecycleManager = pluginLifecycleManager;

        // Initialize router
        this.router = new SettingsRouter();
    }

    /**
     * Update services when they become available
     */
    updateServices(services: {
        workspaceService?: WorkspaceService;
        memoryService?: MemoryService;
    }): void {
        this.memoryService = services.memoryService;
        this.workspaceService = services.workspaceService;

        // Refresh the UI
        this.display();
    }

    /**
     * Cleanup resources
     */
    cleanup(): void {
        if (this.unsubscribeRouter) {
            this.unsubscribeRouter();
        }
        this.router.destroy();
        if (this.tabs) {
            this.tabs.destroy();
        }
        // Cleanup tab instances
        this.defaultsTab?.destroy();
        this.workspacesTab?.destroy();
        this.promptsTab?.destroy();
        this.providersTab?.destroy();
        this.getStartedTab?.destroy();
        // Clear prefetch cache
        this.prefetchedWorkspaces = null;
    }

    /**
     * Prefetch workspaces data in the background
     * Called when settings are opened to reduce perceived load time
     */
    private async prefetchWorkspaces(): Promise<void> {
        if (this.isPrefetching || this.prefetchedWorkspaces !== null) {
            return; // Already prefetching or already cached
        }

        const services = this.getCurrentServices();
        if (!services.workspaceService) {
            return;
        }

        this.isPrefetching = true;
        try {
            this.prefetchedWorkspaces = await services.workspaceService.getAllWorkspaces();
        } catch (error) {
            console.error('[SettingsView] Failed to prefetch workspaces:', error);
            this.prefetchedWorkspaces = null;
        } finally {
            this.isPrefetching = false;
        }
    }

    /**
     * Main display method - renders the settings UI
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('nexus-settings');

        // Start prefetching workspaces in background (non-blocking)
        this.prefetchWorkspaces();

        // 1. Render header (About + Update button)
        this.renderHeader(containerEl);

        // 2. Create tabs
        const tabConfigs: UnifiedTabConfig[] = [
            { key: 'defaults', label: 'Defaults' },
            { key: 'workspaces', label: 'Workspaces' },
            { key: 'prompts', label: 'Prompts' },
            { key: 'providers', label: 'Providers' },
            // { key: 'data', label: 'Data' }, // TODO: Re-enable when Data tab is ready
        ];

        // Get Started tab is desktop-only (MCP setup requires Node.js)
        if (supportsMCPBridge()) {
            tabConfigs.push({ key: 'getstarted', label: 'Get Started' });
        }

        this.tabs = new UnifiedTabs({
            containerEl,
            tabs: tabConfigs,
            defaultTab: this.router.getState().tab,
            onTabChange: (tabKey) => {
                this.router.setTab(tabKey as SettingsTab);
            },
            component: this.plugin
        });

        // 3. Subscribe to router changes
        if (this.unsubscribeRouter) {
            this.unsubscribeRouter();
        }
        this.unsubscribeRouter = this.router.onNavigate((state) => {
            this.renderTabContent(state);
        });

        // 4. Render initial content
        this.renderTabContent(this.router.getState());
    }

    /**
     * Render the header section with About info and Update button
     */
    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('nexus-settings-header');

        // Title and description
        header.createEl('h2', { text: 'Nexus' });
        header.createEl('p', {
            text: 'AI-powered assistant for your Obsidian vault',
            cls: 'nexus-settings-desc'
        });

        // Version and update button
        const versionRow = header.createDiv('nexus-settings-version-row');

        versionRow.createSpan({
            text: `Version ${this.plugin.manifest.version}`,
            cls: 'nexus-settings-version'
        });

        // Update notification if available
        if (this.settingsManager.settings.availableUpdateVersion) {
            const updateBadge = versionRow.createSpan({ cls: 'nexus-update-badge' });
            updateBadge.setText(`Update available: v${this.settingsManager.settings.availableUpdateVersion}`);
        }

        // Update button
        const updateBtn = new ButtonComponent(versionRow);
        updateBtn
            .setButtonText(
                this.settingsManager.settings.availableUpdateVersion
                    ? `Install v${this.settingsManager.settings.availableUpdateVersion}`
                    : 'Check for Updates'
            )
            .onClick(async () => {
                await this.handleUpdateCheck(updateBtn);
            });
    }

    /**
     * Handle update check and installation
     */
    private async handleUpdateCheck(button: ButtonComponent): Promise<void> {
        button.setDisabled(true);
        try {
            const updateManager = new UpdateManager(this.plugin);
            const hasUpdate = await updateManager.checkForUpdate();

            this.settingsManager.settings.lastUpdateCheckDate = new Date().toISOString();

            if (hasUpdate) {
                const release = await (updateManager as unknown as UpdateManagerWithFetchRelease).fetchLatestRelease();
                const availableVersion = release.tag_name.replace('v', '');
                this.settingsManager.settings.availableUpdateVersion = availableVersion;

                await updateManager.updatePlugin();
                this.settingsManager.settings.availableUpdateVersion = undefined;
                this.display();
            } else {
                this.settingsManager.settings.availableUpdateVersion = undefined;
                new Notice('You are already on the latest version!');
            }

            await this.settingsManager.saveSettings();
            this.display();
        } catch (error) {
            new Notice(`Update failed: ${(error as Error).message}`);
        } finally {
            button.setDisabled(false);
        }
    }

    /**
     * Render content for the current tab based on router state
     */
    private renderTabContent(state: RouterState): void {
        if (!this.tabs) return;

        const pane = this.tabs.getTabContent(state.tab);
        if (!pane) return;

        pane.empty();

        // Get current service instances
        const services = this.getCurrentServices();

        switch (state.tab) {
            case 'defaults':
                this.renderDefaultsTab(pane, state, services);
                break;
            case 'workspaces':
                this.renderWorkspacesTab(pane, state, services);
                break;
            case 'prompts':
                this.renderPromptsTab(pane, state, services);
                break;
            case 'providers':
                this.renderProvidersTab(pane, state, services);
                break;
            // case 'data': // TODO: Re-enable when Data tab is ready
            //     this.renderDataTab(pane);
            //     break;
            case 'getstarted':
                this.renderGetStartedTab(pane, services);
                break;
        }
    }

    /**
     * Get current service instances from ServiceManager or stored references
     */
    private getCurrentServices(): {
        memoryService?: MemoryService;
        workspaceService?: WorkspaceService;
        customPromptStorage?: CustomPromptStorageService;
    } {
        let memoryService = this.memoryService;
        let workspaceService = this.workspaceService;

        if (this.serviceManager) {
            const memoryFromManager = this.serviceManager.getServiceIfReady('memoryService') as MemoryService | undefined;
            const workspaceFromManager = this.serviceManager.getServiceIfReady('workspaceService') as WorkspaceService | undefined;

            if (memoryFromManager) memoryService = memoryFromManager;
            if (workspaceFromManager) workspaceService = workspaceFromManager;
        }

        // Initialize custom prompt storage if needed
        if (!this.customPromptStorage) {
            this.customPromptStorage = new CustomPromptStorageService(this.settingsManager);
        }

        return {
            memoryService,
            workspaceService,
            customPromptStorage: this.customPromptStorage
        };
    }

    /**
     * Render Defaults tab content
     */
    private renderDefaultsTab(
        container: HTMLElement,
        state: RouterState,
        services: { workspaceService?: WorkspaceService; customPromptStorage?: CustomPromptStorageService }
    ): void {
        // Destroy previous tab instance if exists
        this.defaultsTab?.destroy();

        // Create new DefaultsTab
        this.defaultsTab = new DefaultsTab(
            container,
            this.router,
            {
                app: this.app,
                settings: this.settingsManager,
                llmProviderSettings: this.settingsManager.settings.llmProviders,
                workspaceService: services.workspaceService,
                customPromptStorage: services.customPromptStorage
            }
        );
    }

    /**
     * Render Workspaces tab content
     */
    private renderWorkspacesTab(
        container: HTMLElement,
        state: RouterState,
        services: { workspaceService?: WorkspaceService; memoryService?: MemoryService }
    ): void {
        // Destroy previous tab instance if exists
        this.workspacesTab?.destroy();

        // Create new WorkspacesTab with prefetched data if available
        this.workspacesTab = new WorkspacesTab(
            container,
            this.router,
            {
                app: this.app,
                workspaceService: services.workspaceService,
                customPromptStorage: this.customPromptStorage,
                prefetchedWorkspaces: this.prefetchedWorkspaces,
                component: this.plugin
            }
        );
    }

    /**
     * Render Prompts tab content
     */
    private renderPromptsTab(
        container: HTMLElement,
        state: RouterState,
        services: { customPromptStorage?: CustomPromptStorageService }
    ): void {
        // Destroy previous tab instance if exists
        this.promptsTab?.destroy();

        // Create new PromptsTab
        this.promptsTab = new PromptsTab(
            container,
            this.router,
            {
                customPromptStorage: services.customPromptStorage
            }
        );
    }

    /**
     * Render Providers tab content
     */
    private renderProvidersTab(
        container: HTMLElement,
        state: RouterState,
        services: any
    ): void {
        // Destroy previous tab instance if exists
        this.providersTab?.destroy();

        // Create new ProvidersTab
        this.providersTab = new ProvidersTab(
            container,
            this.router,
            {
                app: this.app,
                settings: this.settingsManager,
                llmProviderSettings: this.settingsManager.settings.llmProviders
            }
        );
    }

    // TODO: Re-enable when Data tab is ready
    // /**
    //  * Render Data tab content
    //  */
    // private renderDataTab(container: HTMLElement): void {
    //     if (!this.serviceManager) {
    //         container.createEl('div', { text: 'Service Manager not available.' });
    //         return;
    //     }
    //     this.dataTab = new DataTab(container, this.router, this.serviceManager);
    //     this.dataTab.render();
    // }

    /**
     * Render Get Started tab content
     * Uses dynamic import to avoid loading Node.js modules on mobile
     */
    private async renderGetStartedTab(container: HTMLElement, services: any): Promise<void> {
        // Desktop-only - don't render on mobile
        if (!supportsMCPBridge()) {
            container.createEl('p', { text: 'MCP setup is only available on desktop.' });
            return;
        }

        // Destroy previous tab instance if exists
        this.getStartedTab?.destroy();

        // Get plugin path for MCP config
        const vaultBasePath = this.getVaultBasePath();
        const pluginDir = this.plugin.manifest.dir;
        // Extract just the folder name in case manifest.dir contains a full path
        // (e.g., ".obsidian/plugins/claudesidian-mcp" instead of just "claudesidian-mcp")
        const pluginFolderName = pluginDir ? pluginDir.split('/').pop() || pluginDir : '';
        const pluginPath = vaultBasePath && pluginFolderName
            ? `${vaultBasePath}/.obsidian/plugins/${pluginFolderName}`
            : '';
        const vaultPath = vaultBasePath || '';

        // Dynamic import to avoid loading Node.js modules on mobile
        const { GetStartedTab } = await import('./tabs/GetStartedTab');

        // Create new GetStartedTab
        this.getStartedTab = new GetStartedTab(
            container,
            {
                app: this.app,
                pluginPath,
                vaultPath,
                onOpenProviders: () => {
                    this.router.setTab('providers');
                    if (this.tabs) {
                        this.tabs.activateTab('providers');
                    }
                },
                component: this.plugin
            }
        );
    }

    /**
     * Resolve vault base path when running on desktop FileSystemAdapter
     */
    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            return adapter.getBasePath();
        }
        return null;
    }
}
