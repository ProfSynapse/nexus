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

type GetStartedView = 'paths' | 'internal-chat' | 'mcp-setup';

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
        this.container.createEl('h3', { text: 'How would you like to use Nexus?' });

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
    }

    /**
     * Check the status of the Claude config
     */
    private checkConfigStatus(configPath: string, configDir: string): 'no-claude-folder' | 'no-config-file' | 'nexus-configured' | 'config-exists' {
        try {
            // Check if Claude folder exists
            if (!fs.existsSync(configDir)) {
                return 'no-claude-folder';
            }

            // Check if config file exists
            if (!fs.existsSync(configPath)) {
                return 'no-config-file';
            }

            // Check if Nexus is already configured
            const content = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(content);
            const vaultName = this.services.app.vault.getName();
            const serverKey = getPrimaryServerKey(vaultName);

            if (config.mcpServers && config.mcpServers[serverKey]) {
                return 'nexus-configured';
            }

            return 'config-exists';
        } catch (error) {
            console.error('[GetStartedTab] Error checking config status:', error);
            return 'no-claude-folder';
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

            config.mcpServers[serverKey] = {
                command: 'node',
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
