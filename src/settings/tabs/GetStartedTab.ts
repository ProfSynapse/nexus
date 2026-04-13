/**
 * GetStartedTab - Two setup paths and MCP configuration helper
 *
 * Features:
 * - Two setup paths: Internal Chat and MCP Integration
 * - Internal Chat: Configure providers, enable chat view
 * - MCP Integration: Zero-friction setup with one-click config
 * - Platform-specific config file paths
 * - Auto-detect and create Claude config
 */

import { App, Setting, Notice, Platform, Component } from 'obsidian';
import { BackButton } from '../components/BackButton';
import { getPrimaryServerKey } from '../../constants/branding';
import { ConfigStatus, getClaudeDesktopConfigPath, getConfigStatus } from '../getStartedStatus';
import { resolveDesktopBinaryPath } from '../../utils/binaryDiscovery';

type GetStartedView = 'paths' | 'internal-chat' | 'mcp-setup';
type DesktopModuleMap = {
    child_process: typeof import('child_process');
    fs: typeof import('fs');
    path: typeof import('path');
    electron: {
        shell: {
            openExternal(url: string): void | Promise<void>;
            openPath(path: string): Promise<string> | string;
            showItemInFolder(path: string): void;
        };
    };
};

interface ClaudeConfig {
    mcpServers: Record<string, {
        command: string;
        args: string[];
    }>;
}

export interface GetStartedTabServices {
    app: App;
    pluginPath: string;
    vaultPath: string;
    onOpenProviders: () => void;
    component?: Component;
}

export class GetStartedTab {
    private container: HTMLElement;
    private services: GetStartedTabServices;
    private currentView: GetStartedView = 'paths';
    private cachedNodePath: string | null = null;

    constructor(
        container: HTMLElement,
        services: GetStartedTabServices
    ) {
        this.container = container;
        this.services = services;

        this.render();
    }

    /**
     * Main render method
     */
    render(): void {
        this.cachedNodePath = null;
        this.container.empty();

        switch (this.currentView) {
            case 'paths':
                this.renderPathsView();
                break;
            case 'internal-chat':
                this.renderInternalChatSetup();
                break;
            case 'mcp-setup':
                this.renderMCPSetup();
                break;
        }
    }

    /**
     * Render the initial two-path view
     */
    private renderPathsView(): void {
        // Plugin introduction
        const intro = this.container.createDiv('nexus-intro');
        intro.createEl('h3', { text: 'Welcome to Nexus' });
        intro.createEl('p', {
            text: 'Nexus is an AI-powered assistant that lives inside your Obsidian vault. It can read and write your notes, search through your content, and maintain long-term memory of your conversations—all while keeping your data local and private.',
            cls: 'nexus-intro-desc'
        });

        // Key capabilities
        const capabilities = intro.createDiv('nexus-capabilities');
        capabilities.createEl('h4', { text: 'What Nexus can do' });

        const capList = capabilities.createEl('ul', { cls: 'nexus-capability-list' });
        const capItems = [
            { icon: '📝', text: 'Read, create, and edit notes in your vault' },
            { icon: '🔍', text: 'Search content by keywords or semantic meaning' },
            { icon: '🧠', text: 'Remember context across conversations with workspaces' },
            { icon: '📁', text: 'Organize files and folders' },
            { icon: '🤖', text: 'Run custom prompts and spawn sub-agents' },
            { icon: '🔒', text: 'Work fully offline with local LLMs (Ollama, LM Studio)' }
        ];

        for (const cap of capItems) {
            const li = capList.createEl('li');
            li.createSpan({ text: cap.icon, cls: 'nexus-cap-icon' });
            li.createSpan({ text: cap.text });
        }

        // Divider
        this.container.createEl('hr', { cls: 'nexus-divider' });

        // Setup paths header
        this.container.createEl('h3', { text: 'Choose your setup' });
        this.container.createEl('p', {
            text: 'Nexus works in two ways—pick one or use both:',
            cls: 'setting-item-description'
        });

        const paths = this.container.createDiv('nexus-setup-paths');

        // Path 1: Internal Chat
        const chatPath = paths.createDiv('nexus-setup-path');
        chatPath.createDiv('nexus-setup-path-icon').setText('💬');
        chatPath.createDiv('nexus-setup-path-title').setText('Internal chat');
        chatPath.createDiv('nexus-setup-path-desc').setText('Use Nexus directly inside Obsidian');
        const chatClickHandler = () => {
            this.currentView = 'internal-chat';
            this.render();
        };
        const component = this.services.component;
        if (component) {
            component.registerDomEvent(chatPath, 'click', chatClickHandler);
        }

        // Path 2: MCP Integration
        const mcpPath = paths.createDiv('nexus-setup-path');
        mcpPath.createDiv('nexus-setup-path-icon').setText('🔗');
        mcpPath.createDiv('nexus-setup-path-title').setText('MCP integration');
        mcpPath.createDiv('nexus-setup-path-desc').setText('Connect Claude Desktop, LM Studio, etc.');
        const mcpClickHandler = () => {
            this.currentView = 'mcp-setup';
            this.render();
        };
        if (component) {
            component.registerDomEvent(mcpPath, 'click', mcpClickHandler);
        }
    }

    /**
     * Render Internal Chat setup view
     */
    private renderInternalChatSetup(): void {
        new BackButton(
            this.container,
            'Back to get started',
            () => {
                this.currentView = 'paths';
                this.render();
            },
            this.services.component
        );

        this.container.createEl('h3', { text: 'Internal chat setup' });
        this.container.createEl('p', {
            text: 'Use Nexus as an AI chat assistant directly in Obsidian.',
            cls: 'setting-item-description'
        });

        // Step 1: Configure a provider
        const step1 = this.container.createDiv('nexus-setup-step');
        step1.createEl('h4', { text: 'Step 1: configure an LLM provider' });
        step1.createEl('p', {
            text: 'You need at least one LLM provider configured to use the chat.',
            cls: 'setting-item-description'
        });

        new Setting(step1)
            .addButton(btn => btn
                .setButtonText('Configure providers')
                .setCta()
                .onClick(() => {
                    this.services.onOpenProviders();
                }));

        // Step 2: Open chat view
        const step2 = this.container.createDiv('nexus-setup-step');
        step2.createEl('h4', { text: 'Step 2: open the chat view' });
        step2.createEl('p', {
            text: 'Once a provider is configured, you can open the chat view:',
            cls: 'setting-item-description'
        });

        const instructions = step2.createEl('ul', { cls: 'nexus-setup-instructions' });
        instructions.createEl('li', { text: 'Click the chat icon in the left ribbon' });
        instructions.createEl('li', { text: 'Or use the command palette: "Nexus: open chat"' });
        instructions.createEl('li', { text: 'Or use the hotkey: Ctrl/Cmd + Shift + C' });

        // Step 3: Start chatting
        const step3 = this.container.createDiv('nexus-setup-step');
        step3.createEl('h4', { text: 'Step 3: start chatting!' });
        step3.createEl('p', {
            text: 'Your AI assistant has full access to your vault. Ask questions, take notes, and get help with your writing.',
            cls: 'setting-item-description'
        });
    }

    /**
     * Render MCP Integration setup view
     */
    private renderMCPSetup(): void {
        new BackButton(
            this.container,
            'Back to get started',
            () => {
                this.currentView = 'paths';
                this.render();
            },
            this.services.component
        );

        this.container.createEl('h3', { text: 'Claude Desktop setup' });

        // MCP setup requires Node.js modules (path, fs, child_process) — desktop only
        if (!Platform.isDesktop) {
            this.container.createEl('p', {
                text: 'MCP integration requires a desktop environment.',
                cls: 'setting-item-description'
            });
            return;
        }

        // Check for Node.js availability
        const nodePath = this.resolveNodePath();
        if (!nodePath) {
            const nodeWarning = this.container.createDiv('nexus-mcp-row nexus-mcp-node-warning');
            nodeWarning.createEl('span', {
                text: 'Node.js not found',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });
            const actions = nodeWarning.createDiv('nexus-mcp-actions');
            const downloadBtn = actions.createEl('button', { text: 'Install Node.js', cls: 'mod-cta' });
            const downloadHandler = () => window.open('https://nodejs.org', '_blank');
            const component = this.services.component;
            if (component) {
                component.registerDomEvent(downloadBtn, 'click', downloadHandler);
            }
            const refreshBtn = actions.createEl('button', { text: 'Refresh' });
            const refreshHandler = () => this.render();
            if (component) {
                component.registerDomEvent(refreshBtn, 'click', refreshHandler);
            }
            this.container.createEl('p', {
                text: 'Node.js is required to run the MCP connector. Install it, then click refresh.',
                cls: 'nexus-mcp-help'
            });
        }

        const configPath = getClaudeDesktopConfigPath();
        if (!configPath) {
            this.container.createEl('p', {
                text: 'MCP setup is only available on desktop.',
                cls: 'setting-item-description'
            });
            return;
        }

        const configStatus = this.checkConfigStatus();

        // Compact status + action in one row
        if (configStatus === 'no-claude-folder') {
            // Claude not installed - show inline warning with action
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: '⚠️ Claude Desktop not found',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const downloadBtn = actions.createEl('button', { text: 'Download', cls: 'mod-cta' });
            const downloadHandler = () => window.open('https://claude.ai/download', '_blank');
            const component = this.services.component;
            if (component) {
                component.registerDomEvent(downloadBtn, 'click', downloadHandler);
            }

            const refreshBtn = actions.createEl('button', { text: 'Refresh' });
            const refreshHandler = () => this.render();
            if (component) {
                component.registerDomEvent(refreshBtn, 'click', refreshHandler);
            }

            // Help text below
            this.container.createEl('p', {
                text: 'Install Claude Desktop, open it once, then enable settings → developer → MCP servers',
                cls: 'nexus-mcp-help'
            });
        } else if (configStatus === 'nexus-configured') {
            // Already configured - success state
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: '✓ connected',
                cls: 'nexus-mcp-status nexus-mcp-success'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const openBtn = actions.createEl('button', { text: 'Open config' });
            const openHandler = () => this.openConfigFile(configPath);
            const component = this.services.component;
            if (component) {
                component.registerDomEvent(openBtn, 'click', openHandler);
            }

            const revealBtn = actions.createEl('button', { text: this.getRevealButtonText() });
            const revealHandler = () => this.revealInFolder(configPath);
            if (component) {
                component.registerDomEvent(revealBtn, 'click', revealHandler);
            }

            this.container.createEl('p', {
                text: 'Restart Claude Desktop if you haven\'t already.',
                cls: 'nexus-mcp-help'
            });
        } else if (configStatus === 'invalid-config') {
            // Config file exists but is invalid/empty
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: '⚠️ config file is invalid or empty',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const fixBtn = actions.createEl('button', { text: 'Fix config', cls: 'mod-cta' });
            const fixHandler = () => this.autoConfigureNexus(configPath);
            const component = this.services.component;
            if (component) {
                component.registerDomEvent(fixBtn, 'click', fixHandler);
            }

            const openBtn = actions.createEl('button', { text: 'Open config' });
            const openHandler = () => this.openConfigFile(configPath);
            if (component) {
                component.registerDomEvent(openBtn, 'click', openHandler);
            }

            this.container.createEl('p', {
                text: 'The config file exists but has invalid JSON. Click "fix config" to overwrite it, or manually edit.',
                cls: 'nexus-mcp-help'
            });
        } else {
            // Ready to configure
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: configStatus === 'no-config-file' ? 'Ready to configure' : 'Claude Desktop found',
                cls: 'nexus-mcp-status'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const configBtn = actions.createEl('button', { text: 'Add Nexus to Claude', cls: 'mod-cta' });
            const configHandler = () => this.autoConfigureNexus(configPath);
            const component = this.services.component;
            if (component) {
                component.registerDomEvent(configBtn, 'click', configHandler);
            }
        }

        // Always show manual copy-paste section as fallback
        this.renderManualConfigSection(configPath);
    }

    /**
     * Render manual copy-paste configuration section
     */
    private renderManualConfigSection(configPath: string): void {
        this.container.createEl('hr', { cls: 'nexus-divider' });

        const manualSection = this.container.createDiv('nexus-manual-config');
        manualSection.createEl('h4', { text: 'Manual configuration' });
        manualSection.createEl('p', {
            text: 'If auto-configuration doesn\'t work, copy this JSON into your Claude Desktop config:',
            cls: 'setting-item-description'
        });

        // Generate the config JSON
        const configJson = this.getConfigJson();

        // Code block
        const codeBlock = manualSection.createEl('pre', { cls: 'nexus-config-code' });
        codeBlock.createEl('code', { text: configJson });

        // Copy button
        const copyBtn = manualSection.createEl('button', { text: 'Copy configuration', cls: 'mod-cta' });
        const copyHandler = async () => {
            try {
                await navigator.clipboard.writeText(configJson);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy configuration';
                }, 2000);
            } catch {
                new Notice('Failed to copy to clipboard');
            }
        };
        const component = this.services.component;
        if (component) {
            component.registerDomEvent(copyBtn, 'click', copyHandler);
        }

        // Config file path info
        const pathInfo = manualSection.createDiv('nexus-config-path');
        pathInfo.createEl('span', { text: 'Config file location: ', cls: 'setting-item-description' });
        const pathLink = pathInfo.createEl('a', { text: configPath, href: '#' });
        const pathHandler = () => this.revealInFolder(configPath);
        if (component) {
            component.registerDomEvent(pathLink, 'click', pathHandler);
        }
    }

    /**
     * Resolve the absolute path to the Node.js binary.
     * Uses `which` (macOS/Linux) or `where` (Windows) to find node.
     * Result is cached per render cycle (cleared on re-render).
     */
    private resolveNodePath(): string {
        if (this.cachedNodePath !== null) {
            return this.cachedNodePath;
        }
        if (!Platform.isDesktop) {
            this.cachedNodePath = '';
            return '';
        }
        this.cachedNodePath = resolveDesktopBinaryPath('node') ?? '';
        return this.cachedNodePath;
    }

    private loadDesktopModule<TModuleName extends keyof DesktopModuleMap>(
        moduleName: TModuleName
    ): DesktopModuleMap[TModuleName] {
        if (!Platform.isDesktop) {
            throw new Error(`${moduleName} is only available on desktop.`);
        }

        const maybeRequire = (globalThis as typeof globalThis & {
            require?: (moduleId: string) => unknown;
        }).require;

        if (typeof maybeRequire !== 'function') {
            throw new Error('Desktop module loader is unavailable.');
        }

        return maybeRequire(moduleName) as DesktopModuleMap[TModuleName];
    }

    private parseJson(text: string): unknown {
        const parser = JSON.parse as (value: string) => unknown;
        return parser(text);
    }

    private isClaudeConfig(value: unknown): value is ClaudeConfig {
        if (typeof value !== 'object' || value === null) {
            return false;
        }

        const maybeConfig = value as { mcpServers?: unknown };
        return typeof maybeConfig.mcpServers === 'object' && maybeConfig.mcpServers !== null;
    }

    /**
     * Generate the configuration JSON string
     */
    private getConfigJson(): string {
        const pathMod = this.loadDesktopModule('path');
        const vaultName = this.services.app.vault.getName();
        const serverKey = getPrimaryServerKey(vaultName);
        const connectorPath = pathMod.normalize(pathMod.join(this.services.pluginPath, 'connector.js'));
        const nodePath = this.resolveNodePath() || 'node';

        const config = {
            mcpServers: {
                [serverKey]: {
                    command: nodePath,
                    args: [connectorPath]
                }
            }
        };

        return JSON.stringify(config, null, 2);
    }

    /**
     * Check the status of the Claude config
     */
    private checkConfigStatus(): ConfigStatus {
        return getConfigStatus(this.services.app);
    }

    /**
     * Auto-configure Nexus in Claude Desktop config
     */
    private autoConfigureNexus(configPath: string): void {
        const nodeFs = this.loadDesktopModule('fs');
        const pathMod = this.loadDesktopModule('path');
        try {
            let config: ClaudeConfig = { mcpServers: {} };

            // Read existing config if it exists
            if (nodeFs.existsSync(configPath)) {
                const content = nodeFs.readFileSync(configPath, 'utf-8');
                try {
                    const parsed = this.parseJson(content);
                    if (this.isClaudeConfig(parsed)) {
                        config = parsed;
                    }
                    if (!config.mcpServers) {
                        config.mcpServers = {};
                    }
                } catch {
                    // Invalid JSON, start fresh but warn user
                    new Notice('Existing config was invalid JSON. Creating new config.');
                    config = { mcpServers: {} };
                }
            }

            // Add Nexus server config
            const vaultName = this.services.app.vault.getName();
            const serverKey = getPrimaryServerKey(vaultName);
            const connectorPath = pathMod.normalize(pathMod.join(this.services.pluginPath, 'connector.js'));
            const nodePath = this.resolveNodePath();

            if (!nodePath) {
                new Notice('Node.js not found. Please install Node.js and try again.');
                return;
            }

            config.mcpServers[serverKey] = {
                command: nodePath,
                args: [connectorPath]
            };

            // Ensure directory exists
            const configDir = pathMod.dirname(configPath);
            if (!nodeFs.existsSync(configDir)) {
                nodeFs.mkdirSync(configDir, { recursive: true });
            }

            // Write config
            nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

            new Notice('✅ Nexus has been added to Claude Desktop config! Please restart Claude Desktop.');

            // Re-render to show updated status
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error auto-configuring:', error);
            new Notice(`Failed to configure: ${(error as Error).message}`);
        }
    }

    /**
     * Open the config file in the default editor
     */
    private openConfigFile(configPath: string): void {
        try {
            // Use Electron's shell to open the file
            const { shell } = this.loadDesktopModule('electron');
            void shell.openPath(configPath);
        } catch (error) {
            console.error('[GetStartedTab] Error opening config file:', error);
            new Notice('Failed to open config file. Please open it manually.');
        }
    }

    /**
     * Reveal the config file in the system file manager
     */
    private revealInFolder(configPath: string): void {
        try {
            const { shell } = this.loadDesktopModule('electron');
            void shell.showItemInFolder(configPath);
        } catch (error) {
            console.error('[GetStartedTab] Error revealing in folder:', error);
            new Notice('Failed to reveal in folder. Please navigate manually.');
        }
    }

    /**
     * Get OS-specific text for the reveal button
     */
    private getRevealButtonText(): string {
        if (Platform.isWin) {
            return 'Reveal in Explorer';
        } else if (Platform.isMacOS) {
            return 'Reveal in Finder';
        } else {
            return 'Reveal in Files';
        }
    }

    /**
     * Cleanup
     */
    destroy(): void {
        // No resources to clean up
    }
}
