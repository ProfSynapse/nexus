import { App, Plugin, PluginSettingTab, Notice, ButtonComponent, Component, FileSystemAdapter, Platform } from 'obsidian';
import { Settings } from '../settings';
import { UnifiedTabs, UnifiedTabConfig } from '../components/UnifiedTabs';
import { SettingsRouter, RouterState, SettingsPage, SettingsTab } from './SettingsRouter';
import { UpdateManager } from '../utils/UpdateManager';
import { supportsMCPBridge } from '../utils/platform';
import { hasConfiguredProviders, hasExternalAgentSetup } from './getStartedStatus';
import { renderGetStartedPage, renderGetStartedRow } from './getStarted/GetStartedPage';
import { renderChatSetupPage } from './getStarted/ChatSetupPage';

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
import { resolveSemanticSearchRuntime } from './tabs/defaults/SemanticSearchSettings';
import { WorkspacesTab } from './tabs/WorkspacesTab';
import { InstructionsTab } from './tabs/InstructionsTab';
import type { InstructionLibraryService } from '../services/instructions/InstructionLibraryService';
import { ProvidersTab } from './tabs/ProvidersTab';
import { RemoteAgentsTab } from './tabs/RemoteAgentsTab';
import { AppsTab } from './tabs/AppsTab';
import { DataTab } from './tabs/DataTab';

/** Obsidian's settings modal is not part of the public App typings. */
interface AppWithSettingModal {
    setting?: { close(): void };
}

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
    private instructionsTab: InstructionsTab | undefined;
    private providersTab: ProvidersTab | undefined;
    private remoteAgentsTab: RemoteAgentsTab | undefined;
    private appsTab: AppsTab | undefined;
    private dataTab: DataTab | undefined;

    // Body below the header: the Get started row, tab strip and panes, or a page.
    private bodyEl: HTMLElement | undefined;
    // Owns the DOM listeners of whatever the body shows; replaced on every body render.
    private bodyComponent: Component | undefined;
    private renderedPage: SettingsPage | undefined;
    private bodyRenderToken = 0;
    // Get started opens by itself only on the first display() of a plugin session.
    private firstRunChecked = false;

    // Prefetched data cache
    private prefetchedWorkspaces: IndividualWorkspace[] | null = null;
    private isPrefetching = false;

    // Route requested from outside settings, applied on the next display()
    private pendingRoute: Partial<RouterState> | undefined;

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

        // Refresh the UI only while it is on screen. display() reads the current
        // services anyway, and a render nobody sees must not use up the
        // first-run Get started check.
        if (this.containerEl.isConnected) {
            this.display();
        }
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
        this.instructionsTab?.destroy();
        this.providersTab?.destroy();
        this.remoteAgentsTab?.destroy();
        this.appsTab?.destroy();
        this.dataTab?.destroy();
        this.unloadBody();
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
                        new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 5000))
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
     * Ask settings to show a particular tab (and optionally a detail view).
     * Applied immediately when this tab is already on screen, otherwise on
     * the next display(), which Obsidian runs when the tab is opened.
     */
    openTo(route: Partial<RouterState>): void {
        if (this.tabs && this.containerEl.isConnected) {
            this.applyRoute(route);
            return;
        }
        this.pendingRoute = route;
    }

    private applyRoute(route: Partial<RouterState>): void {
        if (route.tab) this.router.setTab(route.tab);
        if (route.view === 'detail' && route.detailId) this.router.showDetail(route.detailId);
        if (route.page) this.router.openPage(route.page);
    }

    /**
     * Settings closed: pages are transient, so the next opening starts on the
     * tab list (on the same tab).
     */
    hide(): void {
        this.unsubscribeRouter?.();
        this.unsubscribeRouter = undefined;
        if (this.router.isPageOpen()) this.router.closePage();
        this.unloadBody();
        super.hide();
    }

    /** Nothing is set up yet: no chat provider and no external agent. */
    private needsGetStarted(): boolean {
        try {
            return !hasConfiguredProviders(this.settingsManager.settings.llmProviders) && !hasExternalAgentSetup(this.app);
        } catch (error) {
            console.error('[SettingsView] Could not check setup state:', error);
            return false;
        }
    }

    /**
     * Main display method - renders the settings UI
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('nexus-settings');

        // Navigate before the body exists, so no stale listener renders the old panes.
        this.unsubscribeRouter?.();
        this.unsubscribeRouter = undefined;

        const pendingRoute = this.pendingRoute;
        this.pendingRoute = undefined;
        if (pendingRoute) {
            this.applyRoute(pendingRoute);
        }

        if (!this.firstRunChecked) {
            this.firstRunChecked = true;
            // A route asked for by other code (e.g. the chat's "Open settings") wins.
            if (!pendingRoute && this.needsGetStarted()) {
                this.router.openPage('get-started');
            }
        }

        // Start prefetching workspaces in background (non-blocking)
        void this.prefetchWorkspaces();

        // 1. Render header (About + Update button)
        this.renderHeader(containerEl);

        // 2. The body: Get started row + tabs, or the open page
        this.bodyEl = containerEl.createDiv({ cls: 'nexus-settings-body' });
        this.renderBody(this.router.getState());

        this.unsubscribeRouter = this.router.onNavigate((state) => {
            if (state.page || this.renderedPage) {
                this.renderBody(state);
                return;
            }
            this.tabs?.activateTab(state.tab, false);
            this.renderTabContent(state);
        });
    }

    /**
     * Tear down what the body holds. The Defaults tab subscribes to provider
     * and indexing events, so it goes with the body; renderBody() builds a new
     * one. (Tabs that may hold an unsaved edit, such as Workspaces, keep their
     * existing lifetime.)
     */
    private unloadBody(): void {
        this.bodyRenderToken++;
        this.defaultsTab?.destroy();
        this.defaultsTab = undefined;
        this.bodyComponent?.unload();
        this.bodyComponent = undefined;
    }

    /** Render the Get started row and the tabs, or the page the router has open. */
    private renderBody(state: RouterState): void {
        const bodyEl = this.bodyEl;
        if (!bodyEl) return;

        this.unloadBody();
        this.tabs?.destroy();
        this.tabs = undefined;
        bodyEl.empty();

        const component = new Component();
        component.load();
        this.bodyComponent = component;
        this.renderedPage = state.page;

        if (state.page) {
            const pageEl = bodyEl.createDiv({ cls: 'nexus-gs-page' });
            this.renderPage(pageEl, state.page, component);
            return;
        }

        renderGetStartedRow(bodyEl, this.router, component);

        const tabConfigs: UnifiedTabConfig[] = [
            { key: 'defaults', label: 'Defaults' },
            { key: 'workspaces', label: 'Workspaces' },
            { key: 'instructions', label: 'Instructions' },
            { key: 'providers', label: 'Providers' },
            { key: 'remote-agents', label: 'Remote agents' },
            { key: 'apps', label: 'Apps' },
            { key: 'data', label: 'Data' },
        ];

        this.tabs = new UnifiedTabs({
            containerEl: bodyEl,
            tabs: tabConfigs,
            defaultTab: this.router.getState().tab,
            onTabChange: (tabKey) => {
                this.router.setTab(tabKey as SettingsTab);
            },
            // The body's own component, so the tab listeners go when the body does.
            component
        });

        this.renderTabContent(state);
    }

    /** Whether the external-agent path (Node.js, desktop only) is offered. */
    private externalAgentsAvailable(): boolean {
        return Platform.isDesktop && supportsMCPBridge();
    }

    private renderPage(pageEl: HTMLElement, page: SettingsPage, component: Component): void {
        const llmProviders = this.settingsManager.settings.llmProviders;
        if (page === 'get-started-chat') {
            renderChatSetupPage(pageEl, {
                app: this.app,
                router: this.router,
                component,
                llmProviders,
                pluginId: this.plugin.manifest.id,
                closeSettings: () => (this.app as unknown as AppWithSettingModal).setting?.close()
            });
            return;
        }
        if (page === 'get-started-agents' && this.externalAgentsAvailable()) {
            void this.renderExternalAgentsPage(pageEl, component);
            return;
        }
        // The Get started page; also stands in for the desktop-only agents page elsewhere.
        renderGetStartedPage(pageEl, {
            app: this.app,
            router: this.router,
            component,
            llmProviders,
            externalAgentsAvailable: this.externalAgentsAvailable()
        });
    }

    /**
     * The external-agent page loads Node-backed helpers, so it is imported on
     * demand and never on mobile.
     */
    private async renderExternalAgentsPage(pageEl: HTMLElement, component: Component): Promise<void> {
        const token = this.bodyRenderToken;
        try {
            const { ExternalAgentsPage } = await import('./getStarted/ExternalAgentsPage');
            if (token !== this.bodyRenderToken) return;
            new ExternalAgentsPage(pageEl, {
                app: this.app,
                router: this.router,
                component,
                pluginPath: this.getPluginPath()
            });
        } catch (error) {
            console.error('[SettingsView] Could not load the external agent setup:', error);
            new Notice('Could not load the external agent setup.');
        }
    }

    /**
     * Render the header section with About info and Update button
     */
    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('nexus-settings-header');

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
                        ? `View v${this.settingsManager.settings.availableUpdateVersion}`
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
                const availableVersion = await updateManager.getLatestVersion();
                this.settingsManager.settings.availableUpdateVersion = availableVersion;

                const releaseUrl = await updateManager.getLatestReleaseUrl();
                new Notice(`Update available: v${availableVersion}. Opening release page.`);
                window.open(releaseUrl, '_blank');
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
            case 'instructions':
            case 'prompts':
                this.renderInstructionsTab(pane);
                break;
            case 'providers':
                this.renderProvidersTab(pane, state, services);
                break;
            case 'remote-agents':
                this.remoteAgentsTab?.destroy();
                this.remoteAgentsTab = new RemoteAgentsTab(pane, {
                    app: this.app,
                    settings: this.settingsManager,
                    serviceManager: this.serviceManager,
                });
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
                customPromptStorage: services.customPromptStorage,
                appManager: this.appManager,
                semanticSearch: {
                    getRuntime: () => resolveSemanticSearchRuntime(this.plugin),
                    applyEnabled: async (enabled: boolean) => {
                        if (this.pluginLifecycleManager) {
                            await this.pluginLifecycleManager.setEmbeddingsEnabled(enabled);
                        } else {
                            await resolveSemanticSearchRuntime(this.plugin)?.setEnabled(enabled);
                        }
                    }
                }
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

    /** The existing Prompts tab becomes the unified Instructions library. */
    private renderInstructionsTab(container: HTMLElement): void {
        if (this.instructionsTab) {
            this.instructionsTab.show(container);
            return;
        }
        this.instructionsTab = new InstructionsTab(container, this.router, {
            app: this.app,
            settings: this.settingsManager,
            getLibrary: async () => {
                if (!this.serviceManager) throw new Error('Instruction services are initializing. Try again shortly.');
                return this.serviceManager.getService<InstructionLibraryService>('instructionLibraryService');
            }
        });
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

    /** Absolute path of this plugin's folder, or '' when the vault is not on the file system. */
    private getPluginPath(): string {
        const vaultBasePath = this.getVaultBasePath();
        const pluginDir = this.plugin.manifest.dir;
        // manifest.dir may be a vault-relative path (".obsidian/plugins/nexus"); keep the folder name.
        const pluginFolderName = pluginDir ? pluginDir.split('/').pop() || pluginDir : '';
        return vaultBasePath && pluginFolderName
            ? `${vaultBasePath}/${this.app.vault.configDir}/plugins/${pluginFolderName}`
            : '';
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
