import { App, Plugin, PluginSettingTab, Notice, ButtonComponent, FileSystemAdapter } from 'obsidian';
import { Settings } from '../settings';
import { UnifiedTabs, UnifiedTabConfig } from '../components/UnifiedTabs';
import { SettingsRouter, RouterState, SettingsTab } from './SettingsRouter';
import { UpdateManager } from '../utils/UpdateManager';
import { supportsMCPBridge } from '../utils/platform';
import { Accordion } from '../components/Accordion';
import { getConfigStatus, hasConfiguredProviders } from './getStartedStatus';

// Type to access private method (should be refactored to make fetchLatestRelease public in UpdateManager)
type UpdateManagerWithFetchRelease = {
    fetchLatestRelease(): Promise<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>;
};

// Services
import { WorkspaceService } from '../services/WorkspaceService';
import { MemoryService } from '../agents/memoryManager/services/MemoryService';
import { CustomPromptStorageService } from '../agents/promptManager/services/CustomPromptStorageService';
import type { ServiceManager } from '../core/ServiceManager';
import type { PluginLifecycleManager } from '../core/PluginLifecycleManager';
import type { IndividualWorkspace } from '../types/storage/StorageTypes';

// Agents
import { SearchManagerAgent } from '../agents/searchManager/searchManager';
import { MemoryManagerAgent } from '../agents/memoryManager/memoryManager';
import type { AppManager } from '../services/apps/AppManager';

// Tab implementations
import { DefaultsTab } from './tabs/DefaultsTab';
import { WorkspacesTab } from './tabs/WorkspacesTab';
import { PromptsTab } from './tabs/PromptsTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { AppsTab } from './tabs/AppsTab';
import { DataTab } from './tabs/DataTab';
// GetStartedTab is dynamically imported (desktop-only, requires Node.js)
type GetStartedTabType = import('./tabs/GetStartedTab').GetStartedTab;

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
    private pluginLifecycleManager: PluginLifecycleManager | undefined;
    private appManager: AppManager | undefined;

    // UI Components
    private tabs: UnifiedTabs | undefined;
    private router: SettingsRouter;
    private unsubscribeRouter: (() => void) | undefined;

    // Tab instances
    private defaultsTab: DefaultsTab | undefined;
    private workspacesTab: WorkspacesTab | undefined;
    private promptsTab: PromptsTab | undefined;
    private providersTab: ProvidersTab | undefined;
    private appsTab: AppsTab | undefined;
    private dataTab: DataTab | undefined;
    private getStartedTab: GetStartedTabType | undefined;
    private getStartedAccordion: Accordion | undefined;

    // Prefetched data cache
    private prefetchedWorkspaces: IndividualWorkspace[] | null = null;
    private isPrefetching = false;

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
        pluginLifecycleManager?: PluginLifecycleManager,
        appManager?: AppManager
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
        this.appManager = appManager;

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
        this.appsTab?.destroy();
        this.dataTab?.destroy();
        this.getStartedTab?.destroy();
        this.getStartedAccordion?.unload();
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

        this.isPrefetching = true;
        try {
            let workspaceService = this.workspaceService;
            if (!workspaceService && this.serviceManager) {
                const syncService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
                if (syncService) {
                    workspaceService = syncService;
                } else {
                    workspaceService = await Promise.race([
                        this.serviceManager.getService<WorkspaceService>('workspaceService'),
                        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000))
                    ]);
                }
            }

            if (!workspaceService) {
                this.prefetchedWorkspaces = null;
                return;
            }

            this.prefetchedWorkspaces = await workspaceService.getAllWorkspaces();
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

        this.getStartedTab?.destroy();
        this.getStartedAccordion?.unload();

        // Start prefetching workspaces in background (non-blocking)
        void this.prefetchWorkspaces();

        // 1. Render header (About + Update button)
        this.renderHeader(containerEl);

        // 2. Render get started accordion above the tabs
        this.renderGetStartedAccordion(containerEl);

        // 3. Create tabs
        const tabConfigs: UnifiedTabConfig[] = [
            { key: 'defaults', label: 'Defaults' },
            { key: 'workspaces', label: 'Workspaces' },
            { key: 'prompts', label: 'Prompts' },
            { key: 'providers', label: 'Providers' },
            { key: 'apps', label: 'Apps' },
            { key: 'data', label: 'Data' },
        ];

        this.tabs = new UnifiedTabs({
            containerEl,
            tabs: tabConfigs,
            defaultTab: this.router.getState().tab,
            onTabChange: (tabKey) => {
                this.router.setTab(tabKey as SettingsTab);
            },
            component: this.plugin
        });

        // 4. Subscribe to router changes
        if (this.unsubscribeRouter) {
            this.unsubscribeRouter();
        }
        this.unsubscribeRouter = this.router.onNavigate((state) => {
            this.renderTabContent(state);
        });

        // 5. Render initial content
        this.renderTabContent(this.router.getState());
    }

    /**
     * Render the header section with About info and Update button
     */
    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('nexus-settings-header');

        // Title and description
        ;
        header.createEl('p', {
            text: 'An assistant for your vault',
            cls: 'nexus-settings-desc'
        });

        // Version and update button
        const versionRow = header.createDiv('nexus-settings-version-row');

        versionRow.createSpan({
            text: `Version ${this.plugin.manifest.version}`,
            cls: 'nexus-settings-version'
        });

        // Conditionally show update UI (hidden when plugin is in the community store)
        void UpdateManager.isStoreAvailable(this.plugin.manifest.id).then((storeAvailable) => {
            if (storeAvailable) return;

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
            case 'apps':
                this.renderAppsTab(pane, state, services);
                break;
            case 'data':
                this.renderDataTab(pane);
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
            // Try ServiceManager first (has db, writes to SQLite + data.json)
            if (this.serviceManager) {
                const storageFromManager = this.serviceManager.getServiceIfReady<CustomPromptStorageService>('customPromptStorageService');
                if (storageFromManager) {
                    this.customPromptStorage = storageFromManager;
                }
            }
            // Fallback: create without db (writes to data.json only)
            if (!this.customPromptStorage) {
                this.customPromptStorage = new CustomPromptStorageService(null, this.settingsManager);
            }
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

        // Always pass null so WorkspacesTab takes the async loading path
        // (skeleton → loadWorkspaces() with adapter wait → re-render).
        // This avoids using stale prefetch data from before SQLite was ready.
        this.workspacesTab = new WorkspacesTab(
            container,
            this.router,
            {
                app: this.app,
                workspaceService: services.workspaceService,
                customPromptStorage: this.customPromptStorage,
                prefetchedWorkspaces: null,
                serviceManager: this.serviceManager,
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
                customPromptStorage: services.customPromptStorage,
                component: this.plugin
            }
        );
    }

    /**
     * Render Providers tab content
     */
    private renderProvidersTab(
        container: HTMLElement,
        _state: RouterState,
        _services: { memoryService?: MemoryService; workspaceService?: WorkspaceService; customPromptStorage?: CustomPromptStorageService }
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

    /**
     * Render Apps tab content
     */
    private renderAppsTab(
        container: HTMLElement,
        _state: RouterState,
        _services: { memoryService?: MemoryService; workspaceService?: WorkspaceService; customPromptStorage?: CustomPromptStorageService }
    ): void {
        this.appsTab?.destroy();
        this.appsTab = new AppsTab(
            container,
            this.router,
            {
                app: this.app,
                settings: this.settingsManager,
                appManager: this.appManager,
            }
        );
    }

    /**
     * Render Data tab content
     */
    private renderDataTab(container: HTMLElement): void {
        this.dataTab?.destroy();
        this.dataTab = new DataTab(container, {
            app: this.app,
            settings: this.settingsManager,
            serviceManager: this.serviceManager
        });
        this.dataTab.render();
    }

    private renderGetStartedAccordion(containerEl: HTMLElement): void {
        if (!supportsMCPBridge()) {
            return;
        }

        const hasProviders = hasConfiguredProviders(this.settingsManager.settings.llmProviders);
        const mcpConfigured = getConfigStatus(this.app) === 'nexus-configured';

        this.getStartedAccordion = new Accordion(
            containerEl,
            'Get Started',
            !hasProviders || !mcpConfigured
        );
        this.getStartedAccordion.rootEl.addClass('nexus-settings-accordion');

        const accordionContent = this.getStartedAccordion.getContentEl();
        accordionContent.addClass('nexus-settings-accordion-content');

        void this.renderGetStartedContent(accordionContent);
    }

    /**
     * Render Get Started accordion content
     * Uses dynamic import to avoid loading Node.js modules on mobile
     */
    private async renderGetStartedContent(container: HTMLElement): Promise<void> {
        // Destroy previous tab instance if exists
        this.getStartedTab?.destroy();

        // Get plugin path for MCP config
        const vaultBasePath = this.getVaultBasePath();
        const pluginDir = this.plugin.manifest.dir;
        // Extract just the folder name in case manifest.dir contains a full path
        // (e.g., ".obsidian/plugins/claudesidian-mcp" instead of just "claudesidian-mcp")
        const pluginFolderName = pluginDir ? pluginDir.split('/').pop() || pluginDir : '';
        const pluginPath = vaultBasePath && pluginFolderName
            ? `${vaultBasePath}/${this.app.vault.configDir}/plugins/${pluginFolderName}`
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
                component: this.getStartedAccordion
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
