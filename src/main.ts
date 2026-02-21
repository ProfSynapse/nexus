import { Plugin, Notice, Platform } from 'obsidian';
import { Settings } from './settings';
import { ServiceManager } from './core/ServiceManager';
import { PluginLifecycleManager, type PluginLifecycleConfig } from './core/PluginLifecycleManager';
import { BRAND_NAME } from './constants/branding';
import { supportsMCPBridge } from './utils/platform';
import { WasmEnsurer } from './utils/WasmEnsurer';
import type { PluginServices } from './types/plugin/PluginTypes';

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
    public get services(): PluginServices {
        const services: PluginServices = {};
        if (!this.serviceManager) {
            return services;
        }
        // Return only ready services for immediate access
        // These are used by agent tools for activity recording and UI components
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
            // Ensure sqlite3.wasm exists (desktop only - SQLite not used on mobile)
            if (Platform.isDesktop) {
                const wasmEnsurer = new WasmEnsurer(this);
                const wasmReady = await wasmEnsurer.ensureWasmExists();
                if (!wasmReady) {
                    console.warn(`[${BRAND_NAME}] SQLite WASM not available - some features may be limited`);
                }
            }

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
            }

            // Register OAuth providers (desktop only — needs local callback server)
            if (Platform.isDesktop) {
                try {
                    const { OAuthService } = await import('./services/oauth/OAuthService');
                    const { OpenRouterOAuthProvider } = await import('./services/oauth/providers/OpenRouterOAuthProvider');
                    const { OpenAICodexOAuthProvider } = await import('./services/oauth/providers/OpenAICodexOAuthProvider');

                    const oauthService = OAuthService.getInstance();
                    oauthService.registerProvider(new OpenRouterOAuthProvider());
                    oauthService.registerProvider(new OpenAICodexOAuthProvider());
                } catch (error) {
                    console.error(`[${BRAND_NAME}] Failed to initialize OAuth providers:`, error);
                    // Continue without OAuth — manual API key entry still works
                }
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
