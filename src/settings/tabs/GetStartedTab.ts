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
import { BRAND_NAME, getPrimaryServerKey } from '../../constants/branding';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

type GetStartedView = 'paths' | 'internal-chat' | 'mcp-setup';
type ConfigStatus = 'no-claude-folder' | 'no-config-file' | 'nexus-configured' | 'config-exists' | 'invalid-config';

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
        chatPath.createDiv('nexus-setup-path-title').setText('Internal Chat');
        chatPath.createDiv('nexus-setup-path-desc').setText('Use Nexus directly inside Obsidian');
        const chatClickHandler = () => {
            this.currentView = 'internal-chat';
            this.render();
        };
        this.services.component!.registerDomEvent(chatPath, 'click', chatClickHandler);

        // Path 2: MCP Integration
        const mcpPath = paths.createDiv('nexus-setup-path');
        mcpPath.createDiv('nexus-setup-path-icon').setText('🔗');
        mcpPath.createDiv('nexus-setup-path-title').setText('MCP Integration');
        mcpPath.createDiv('nexus-setup-path-desc').setText('Connect Claude Desktop, LM Studio, etc.');
        const mcpClickHandler = () => {
            this.currentView = 'mcp-setup';
            this.render();
        };
        this.services.component!.registerDomEvent(mcpPath, 'click', mcpClickHandler);
    }

    /**
     * Render Internal Chat setup view
     */
    private renderInternalChatSetup(): void {
        new BackButton(this.container, 'Back', () => {
            this.currentView = 'paths';
            this.render();
        }, this.services.component);

        this.container.createEl('h3', { text: 'Internal Chat Setup' });
        this.container.createEl('p', {
            text: 'Use Nexus as an AI chat assistant directly in Obsidian.',
            cls: 'setting-item-description'
        });

        // Step 1: Configure a provider
        const step1 = this.container.createDiv('nexus-setup-step');
        step1.createEl('h4', { text: 'Step 1: Configure an LLM Provider' });
        step1.createEl('p', {
            text: 'You need at least one LLM provider configured to use the chat.',
            cls: 'setting-item-description'
        });

        new Setting(step1)
            .addButton(btn => btn
                .setButtonText('Configure Providers')
                .setCta()
                .onClick(() => {
                    this.services.onOpenProviders();
                }));

        // Step 2: Open chat view
        const step2 = this.container.createDiv('nexus-setup-step');
        step2.createEl('h4', { text: 'Step 2: Open the Chat View' });
        step2.createEl('p', {
            text: 'Once a provider is configured, you can open the chat view:',
            cls: 'setting-item-description'
        });

        const instructions = step2.createEl('ul', { cls: 'nexus-setup-instructions' });
        instructions.createEl('li', { text: 'Click the chat icon in the left ribbon' });
        instructions.createEl('li', { text: 'Or use the command palette: "Nexus: Open Chat"' });
        instructions.createEl('li', { text: 'Or use the hotkey: Ctrl/Cmd + Shift + C' });

        // Step 3: Start chatting
        const step3 = this.container.createDiv('nexus-setup-step');
        step3.createEl('h4', { text: 'Step 3: Start Chatting!' });
        step3.createEl('p', {
            text: 'Your AI assistant has full access to your vault. Ask questions, take notes, and get help with your writing.',
            cls: 'setting-item-description'
        });
    }

    /**
     * Render MCP Integration setup view
     */
    private renderMCPSetup(): void {
        new BackButton(this.container, 'Back', () => {
            this.currentView = 'paths';
            this.render();
        }, this.services.component);

        this.container.createEl('h3', { text: 'Claude Desktop Setup' });

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
            this.services.component!.registerDomEvent(downloadBtn, 'click', downloadHandler);
            const refreshBtn = actions.createEl('button', { text: 'Refresh' });
            const refreshHandler = () => this.render();
            this.services.component!.registerDomEvent(refreshBtn, 'click', refreshHandler);
            this.container.createEl('p', {
                text: 'Node.js is required to run the MCP connector. Install it, then click Refresh.',
                cls: 'nexus-mcp-help'
            });
        }

        const configPath = this.getClaudeDesktopConfigPath();
        const configDir = path.dirname(configPath);
        const configStatus = this.checkConfigStatus(configPath, configDir);

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
            this.services.component!.registerDomEvent(downloadBtn, 'click', downloadHandler);

            const refreshBtn = actions.createEl('button', { text: 'Refresh' });
            const refreshHandler = () => this.render();
            this.services.component!.registerDomEvent(refreshBtn, 'click', refreshHandler);

            // Help text below
            this.container.createEl('p', {
                text: 'Install Claude Desktop, open it once, then enable Settings → Developer → MCP Servers',
                cls: 'nexus-mcp-help'
            });
        } else if (configStatus === 'nexus-configured') {
            // Already configured - success state
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: '✓ Connected',
                cls: 'nexus-mcp-status nexus-mcp-success'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const openBtn = actions.createEl('button', { text: 'Open Config' });
            const openHandler = () => this.openConfigFile(configPath);
            this.services.component!.registerDomEvent(openBtn, 'click', openHandler);

            const revealBtn = actions.createEl('button', { text: this.getRevealButtonText() });
            const revealHandler = () => this.revealInFolder(configPath);
            this.services.component!.registerDomEvent(revealBtn, 'click', revealHandler);

            this.container.createEl('p', {
                text: 'Restart Claude Desktop if you haven\'t already.',
                cls: 'nexus-mcp-help'
            });
        } else if (configStatus === 'invalid-config') {
            // Config file exists but is invalid/empty
            const row = this.container.createDiv('nexus-mcp-row');
            row.createEl('span', {
                text: '⚠️ Config file is invalid or empty',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });

            const actions = row.createDiv('nexus-mcp-actions');
            const fixBtn = actions.createEl('button', { text: 'Fix Config', cls: 'mod-cta' });
            const fixHandler = () => this.autoConfigureNexus(configPath);
            this.services.component!.registerDomEvent(fixBtn, 'click', fixHandler);

            const openBtn = actions.createEl('button', { text: 'Open Config' });
            const openHandler = () => this.openConfigFile(configPath);
            this.services.component!.registerDomEvent(openBtn, 'click', openHandler);

            this.container.createEl('p', {
                text: 'The config file exists but has invalid JSON. Click "Fix Config" to overwrite it, or manually edit.',
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
            this.services.component!.registerDomEvent(configBtn, 'click', configHandler);
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
        manualSection.createEl('h4', { text: 'Manual Configuration' });
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
        const copyBtn = manualSection.createEl('button', { text: 'Copy Configuration', cls: 'mod-cta' });
        const copyHandler = async () => {
            try {
                await navigator.clipboard.writeText(configJson);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy Configuration';
                }, 2000);
            } catch (error) {
                new Notice('Failed to copy to clipboard');
            }
        };
        this.services.component!.registerDomEvent(copyBtn, 'click', copyHandler);

        // Config file path info
        const pathInfo = manualSection.createDiv('nexus-config-path');
        pathInfo.createEl('span', { text: 'Config file location: ', cls: 'setting-item-description' });
        const pathLink = pathInfo.createEl('a', { text: configPath, href: '#' });
        const pathHandler = () => this.revealInFolder(configPath);
        this.services.component!.registerDomEvent(pathLink, 'click', pathHandler);
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
        try {
            const cmd = Platform.isWin ? 'where node' : 'which node';
            const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
            // `where` on Windows may return multiple lines; take the first
            const firstLine = result.split('\n')[0].trim();
            if (firstLine && fs.existsSync(firstLine)) {
                this.cachedNodePath = firstLine;
                return firstLine;
            }
        } catch {
            // Node not found in PATH
        }
        this.cachedNodePath = '';
        return '';
    }

    /**
     * Generate the configuration JSON string
     */
    private getConfigJson(): string {
        const vaultName = this.services.app.vault.getName();
        const serverKey = getPrimaryServerKey(vaultName);
        const connectorPath = path.normalize(path.join(this.services.pluginPath, 'connector.js'));
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
    private checkConfigStatus(configPath: string, configDir: string): ConfigStatus {
        // Check if Claude folder exists
        if (!fs.existsSync(configDir)) {
            return 'no-claude-folder';
        }

        // Check if config file exists
        if (!fs.existsSync(configPath)) {
            return 'no-config-file';
        }

        // Try to read and parse the config
        try {
            const content = fs.readFileSync(configPath, 'utf-8');

            // Handle empty file
            if (!content.trim()) {
                return 'invalid-config';
            }

            const config = JSON.parse(content);
            const vaultName = this.services.app.vault.getName();
            const serverKey = getPrimaryServerKey(vaultName);

            if (config.mcpServers && config.mcpServers[serverKey]) {
                return 'nexus-configured';
            }

            return 'config-exists';
        } catch (error) {
            // JSON parse error - config file exists but is invalid
            console.error('[GetStartedTab] Error parsing config:', error);
            return 'invalid-config';
        }
    }

    /**
     * Auto-configure Nexus in Claude Desktop config
     */
    private async autoConfigureNexus(configPath: string): Promise<void> {
        try {
            let config: any = { mcpServers: {} };

            // Read existing config if it exists
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                try {
                    config = JSON.parse(content);
                    if (!config.mcpServers) {
                        config.mcpServers = {};
                    }
                } catch (e) {
                    // Invalid JSON, start fresh but warn user
                    new Notice('Existing config was invalid JSON. Creating new config.');
                    config = { mcpServers: {} };
                }
            }

            // Add Nexus server config
            const vaultName = this.services.app.vault.getName();
            const serverKey = getPrimaryServerKey(vaultName);
            const connectorPath = path.normalize(path.join(this.services.pluginPath, 'connector.js'));
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
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // Write config
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

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
            const { shell } = require('electron');
            shell.openPath(configPath);
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
            const { shell } = require('electron');
            shell.showItemInFolder(configPath);
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
     * Get Claude Desktop config file path based on platform
     */
    private getClaudeDesktopConfigPath(): string {
        if (Platform.isWin) {
            return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
        } else if (Platform.isMacOS) {
            return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        } else {
            // Linux
            return path.join(process.env.HOME || '', '.config', 'Claude', 'claude_desktop_config.json');
        }
    }

    /**
     * Cleanup
     */
    destroy(): void {
        // No resources to clean up
    }
}
