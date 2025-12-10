import { Plugin, Notice } from 'obsidian';
import { Settings } from './settings';
import { ServiceManager } from './core/ServiceManager';
import { PluginLifecycleManager, type PluginLifecycleConfig } from './core/PluginLifecycleManager';
import { BRAND_NAME } from './constants/branding';
import { isMobile, supportsMCPBridge, getPlatformName } from './utils/platform';

// MCPConnector type for desktop-only dynamic import
type MCPConnectorType = import('./connector').MCPConnector;

export default class NexusPlugin extends Plugin {
    public settings!: Settings;
    private connector!: MCPConnectorType;
    private serviceManager!: ServiceManager;
    private lifecycleManager!: PluginLifecycleManager;

    /**
     * Get a service asynchronously
     */
    public async getService<T>(name: string, timeoutMs?: number): Promise<T | null> {
        if (!this.serviceManager) {
            return null;
        }
        try {
            return await this.serviceManager.getService<T>(name);
        } catch (error) {
            console.error(`[${BRAND_NAME}] Failed to get service ${name}:`, error);
            return null;
        }
    }

    // Get service if already initialized (non-blocking)
    public getServiceIfReady<T>(name: string): T | null {
        if (!this.serviceManager) {
            return null;
        }
        return this.serviceManager.getServiceIfReady<T>(name);
    }

    // Service registry - for backward compatibility
    public get services(): Record<string, any> {
        const services: Record<string, any> = {};
        if (!this.serviceManager) {
            return services;
        }
        // Return only ready services for immediate access
        // These are used by agent modes for activity recording and UI components
        const serviceNames = ['memoryService', 'workspaceService', 'sessionService', 'conversationService', 'customPromptStorageService'];
        for (const name of serviceNames) {
            const service = this.serviceManager.getServiceIfReady(name);
            if (service) {
                services[name] = service;
            }
        }
        return services;
    }

    async onload() {
        try {
            const platform = getPlatformName();
            console.log(`[${BRAND_NAME}] Loading on ${platform}${isMobile() ? ' (mobile)' : ''}`);

            // Create service manager and settings
            this.settings = new Settings(this);
            this.serviceManager = new ServiceManager(this.app, this);

            // MCP server and connector only work on desktop (requires Node.js)
            // Use dynamic imports to avoid bundling Node.js dependencies on mobile
            if (supportsMCPBridge()) {
                try {
                    // Dynamic import - only loads on desktop, avoids Node.js deps on mobile
                    const { ConnectorEnsurer } = await import('./utils/ConnectorEnsurer');
                    const { MCPConnector } = await import('./connector');

                    // Ensure connector.js exists (self-healing if missing)
                    const connectorEnsurer = new ConnectorEnsurer(this);
                    await connectorEnsurer.ensureConnectorExists();

                    // Initialize connector skeleton (no agents yet)
                    this.connector = new MCPConnector(this.app, this);
                } catch (error) {
                    console.error(`[${BRAND_NAME}] Failed to initialize MCP connector:`, error);
                    // Continue without MCP - chat still works
                }
            } else {
                console.log(`[${BRAND_NAME}] MCP server disabled on mobile - chat works with cloud LLM providers`);
            }

            // Create and initialize lifecycle manager
            const lifecycleConfig: PluginLifecycleConfig = {
                plugin: this,
                app: this.app,
                serviceManager: this.serviceManager,
                settings: this.settings,
                connector: this.connector, // May be undefined on mobile
                manifest: this.manifest
            };

            this.lifecycleManager = new PluginLifecycleManager(lifecycleConfig);
            await this.lifecycleManager.initialize();

        } catch (error) {
            console.error(`[${BRAND_NAME}] Plugin loading failed:`, error);
            new Notice(`${BRAND_NAME}: Plugin failed to load. Check console for details.`);
            throw error;
        }
    }

    async onunload() {
        // Shutdown lifecycle manager first (handles UI cleanup)
        if (this.lifecycleManager) {
            await this.lifecycleManager.shutdown();
        }

        // Stop connector
        if (this.connector) {
            await this.connector.stop();
        }

        // Service manager cleanup handled by lifecycle manager
    }

    /**
     * Get service manager for direct access if needed
     */
    public getServiceContainer(): ServiceManager {
        return this.serviceManager;
    }
}
