import { App, Component, FileSystemAdapter, Modal, Platform, Setting, normalizePath } from 'obsidian';
import * as path from 'path';
import { getAllPluginIds, getPrimaryServerKey, BRAND_NAME } from '../constants/branding';

/**
 * Configuration modal for the plugin
 * Provides setup instructions for different operating systems
 */
export class ConfigModal extends Modal {
    private activeTab = 'windows';
    private tabButtons: Record<string, HTMLElement> = {};
    private tabContents: Record<string, HTMLElement> = {};
    private isFirstTimeSetup = true;
    private component = new Component();
    
    /**
     * Create a new configuration modal
     * @param app Obsidian app instance
     * @param settings Settings instance (optional)
     */
    constructor(app: App) {
        super(app);
    }
    
    /**
     * Called when the modal is opened
     */
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.component.load();
        
        contentEl.createEl('h2', { text: 'MCP Configuration' });

        // Add configuration type toggle
        const toggleContainer = contentEl.createDiv({ cls: 'mcp-config-toggle' });
        toggleContainer.createEl('span', { text: 'Configuration Type:', cls: 'mcp-config-label' });
        new Setting(toggleContainer)
            .setName('First Time Setup')
            .setDesc('Toggle between first-time setup and adding to existing configuration')
            .addToggle(toggle => toggle
                .setValue(this.isFirstTimeSetup)
                .onChange(value => {
                    this.isFirstTimeSetup = value;
                    void this.updateConfigDisplay();
                }));

        // Create tab container
        const tabContainer = contentEl.createDiv({ cls: 'mcp-config-tabs' });
        
        // Add tab buttons
        this.createTabButtons(tabContainer);
        
        // Create content container
        const contentContainer = contentEl.createDiv({ cls: 'mcp-config-content' });
        
        // Create tab contents
        this.createWindowsTab(contentContainer);
        this.createMacTab(contentContainer);
        this.createLinuxTab(contentContainer);
        
        // Show default tab
        this.showTab(this.activeTab);
        
        // Add CSS
        this.addStyles();
        
        // Close button
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Close')
                .onClick(() => {
                    this.close();
                }));
    }
    
    /**
     * Create tab buttons
     * @param container Container element
     */
    private createTabButtons(container: HTMLElement) {
        const tabButtonContainer = container.createDiv({ cls: 'mcp-tab-buttons' });
        
        // Windows tab button
        const windowsButton = tabButtonContainer.createEl('button', {
            text: 'Windows',
            cls: 'mcp-tab-button'
        });
        this.component.registerDomEvent(windowsButton, 'click', () => this.showTab('windows'));
        this.tabButtons['windows'] = windowsButton;

        // Mac tab button
        const macButton = tabButtonContainer.createEl('button', {
            text: 'Mac',
            cls: 'mcp-tab-button'
        });
        this.component.registerDomEvent(macButton, 'click', () => this.showTab('mac'));
        this.tabButtons['mac'] = macButton;

        // Linux tab button
        const linuxButton = tabButtonContainer.createEl('button', {
            text: 'Linux',
            cls: 'mcp-tab-button'
        });
        this.component.registerDomEvent(linuxButton, 'click', () => this.showTab('linux'));
        this.tabButtons['linux'] = linuxButton;
        
        // Auto-select current platform
        if (Platform.isMacOS) {
            this.activeTab = 'mac';
        } else if (Platform.isLinux) {
            this.activeTab = 'linux';
        }
    }
    
    /**
     * Create Windows tab content
     * @param container Container element
     */
    private createWindowsTab(container: HTMLElement) {
        const windowsContent = container.createDiv({ cls: 'mcp-tab-content hidden' });
        this.tabContents['windows'] = windowsContent;
        
        const instructions = windowsContent.createEl('div');
        instructions.createEl('p', { text: `To configure Claude Desktop to work with ${BRAND_NAME} on Windows:` });

        const steps = instructions.createEl('ol');

        // Step 1: Create config file through Claude Desktop
        const step1 = steps.createEl('li');
        step1.appendText('Open Claude Desktop → ');
        step1.createEl('strong', { text: 'Settings' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Developer' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Edit Config' });
        step1.appendText(' (this creates the config file if it doesn\'t exist)');

        // Step 2: Alternative - use file link
        const step2 = steps.createEl('li');
        step2.appendText('Alternatively, open the config file directly: ');

        const configPath = '%AppData%\\Claude\\claude_desktop_config.json';
        const configLink = step2.createEl('a', {
            text: configPath,
            href: '#'
        });

        this.component.registerDomEvent(configLink, 'click', async (e) => {
            e.preventDefault();
            // Try to open the file with system's default program
            const actualPath = this.getWindowsConfigPath();
            window.open('file:///' + actualPath.replace(/\\/g, '/'), '_blank');
        });

        // Step 3: Copy configuration
        steps.createEl('li', { text: 'Copy the following JSON configuration:' });
        
        const codeBlock = windowsContent.createEl('pre');
        const codeEl = codeBlock.createEl('code', {
            text: JSON.stringify(this.getConfigurationSyncPlaceholder(), null, 2)
        });
        
        // Copy button
        const copyButton = windowsContent.createEl('button', {
            text: 'Copy Configuration',
            cls: 'mod-cta'
        });
        
        this.populateTabConfig('windows', codeEl, copyButton);
        
        // Remaining steps
        steps.createEl('li', { text: this.isFirstTimeSetup
            ? 'Paste this into your config file, replacing any existing content'
            : 'Add this to the mcpServers section of your existing config file'
        });
        steps.createEl('li', { text: 'Save the file and restart Claude Desktop' });
    }
    
    /**
     * Create Mac tab content
     * @param container Container element
     */
    private createMacTab(container: HTMLElement) {
        const macContent = container.createDiv({ cls: 'mcp-tab-content hidden' });
        this.tabContents['mac'] = macContent;
        
        const instructions = macContent.createEl('div');
        instructions.createEl('p', { text: `To configure Claude Desktop to work with ${BRAND_NAME} on Mac:` });

        const steps = instructions.createEl('ol');

        // Step 1: Create config file through Claude Desktop
        const step1 = steps.createEl('li');
        step1.appendText('Open Claude Desktop → ');
        step1.createEl('strong', { text: 'Settings' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Developer' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Edit Config' });
        step1.appendText(' (this creates the config file if it doesn\'t exist)');

        // Step 2: Alternative - use file link
        const step2 = steps.createEl('li');
        step2.appendText('Alternatively, open the config file directly: ');

        const configPath = '~/Library/Application Support/Claude/claude_desktop_config.json';
        const configLink = step2.createEl('a', {
            text: configPath,
            href: '#'
        });

        this.component.registerDomEvent(configLink, 'click', async (e) => {
            e.preventDefault();
            // Try to open the file with system's default program
            const actualPath = this.getMacConfigPath();
            window.open('file://' + actualPath, '_blank');
        });

        // Step 3: Copy configuration
        steps.createEl('li', { text: 'Copy the following JSON configuration:' });

        const codeBlock = macContent.createEl('pre');
        const codeEl = codeBlock.createEl('code', {
            text: JSON.stringify(this.getConfigurationSyncPlaceholder(), null, 2)
        });
        
        // Copy button
        const copyButton = macContent.createEl('button', {
            text: 'Copy Configuration',
            cls: 'mod-cta'
        });
        
        this.populateTabConfig('mac', codeEl, copyButton);
        
        // Remaining steps
        steps.createEl('li', { text: this.isFirstTimeSetup
            ? 'Paste this into your config file, replacing any existing content'
            : 'Add this to the mcpServers section of your existing config file'
        });
        steps.createEl('li', { text: 'Save the file and restart Claude Desktop' });
    }
    
    /**
     * Create Linux tab content
     * @param container Container element
     */
    private createLinuxTab(container: HTMLElement) {
        const linuxContent = container.createDiv({ cls: 'mcp-tab-content hidden' });
        this.tabContents['linux'] = linuxContent;
        
        const instructions = linuxContent.createEl('div');
        instructions.createEl('p', { text: `To configure Claude Desktop to work with ${BRAND_NAME} on Linux:` });

        const steps = instructions.createEl('ol');

        // Step 1: Create config file through Claude Desktop
        const step1 = steps.createEl('li');
        step1.appendText('Open Claude Desktop → ');
        step1.createEl('strong', { text: 'Settings' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Developer' });
        step1.appendText(' → ');
        step1.createEl('strong', { text: 'Edit Config' });
        step1.appendText(' (this creates the config file if it doesn\'t exist)');

        // Step 2: Alternative - use file link
        const step2 = steps.createEl('li');
        step2.appendText('Alternatively, open the config file directly: ');

        const configPath = '~/.config/Claude/claude_desktop_config.json';
        const configLink = step2.createEl('a', {
            text: configPath,
            href: '#'
        });

        this.component.registerDomEvent(configLink, 'click', async (e) => {
            e.preventDefault();
            // Try to open the file with system's default program
            const actualPath = this.getLinuxConfigPath();
            window.open('file://' + actualPath, '_blank');
        });

        // Step 3: Copy configuration
        steps.createEl('li', { text: 'Copy the following JSON configuration:' });

        const codeBlock = linuxContent.createEl('pre');
        const codeEl = codeBlock.createEl('code', {
            text: JSON.stringify(this.getConfigurationSyncPlaceholder(), null, 2)
        });
        
        // Copy button
        const copyButton = linuxContent.createEl('button', {
            text: 'Copy Configuration',
            cls: 'mod-cta'
        });
        
        this.populateTabConfig('linux', codeEl, copyButton);
        
        // Remaining steps
        steps.createEl('li', { text: this.isFirstTimeSetup
            ? 'Paste this into your config file, replacing any existing content'
            : 'Add this to the mcpServers section of your existing config file'
        });
        steps.createEl('li', { text: 'Save the file and restart Claude Desktop' });
    }
    
    /**
     * Show a specific tab
     * @param tabId Tab ID to show
     */
    private showTab(tabId: string) {
        // Update active tab
        this.activeTab = tabId;
        
        // Update button styles
        for (const [id, button] of Object.entries(this.tabButtons)) {
            if (id === tabId) {
                button.addClass('mcp-tab-active');
            } else {
                button.removeClass('mcp-tab-active');
            }
        }
        
        // Show/hide content
        for (const [id, content] of Object.entries(this.tabContents)) {
            if (id === tabId) {
                content.removeClass('hidden');
                content.addClass('active');
            } else {
                content.addClass('hidden');
                content.removeClass('active');
            }
        }
    }
    
    /**
     * Add CSS styles for the modal (now implemented in styles.css)
     */
    private addStyles() {
        // All styles are now in the global styles.css file
    }
    
    /**
     * Get the configuration object for a specific OS
     * @param os Operating system (windows, mac, linux)
     * @returns Configuration object
     */
    /**
     * Update the configuration display based on selected mode
     */
    private async updateConfigDisplay() {
        // Update all tab contents with new configuration
        for (const tabId of Object.keys(this.tabContents)) {
            const content = this.tabContents[tabId];
            const codeBlock = content.querySelector('pre code') as HTMLElement | null;
            const copyButton = content.querySelector('button.mod-cta') as HTMLButtonElement | null;
            if (codeBlock && copyButton) {
                await this.populateTabConfig(tabId, codeBlock, copyButton);
            }
        }
    }

    /**
     * Get the configuration object for a specific OS
     * @param os Operating system (windows, mac, linux)
     * @returns Configuration object
     */
    /**
     * Get the configuration object for a specific OS
     * @param os Operating system (windows, mac, linux)
     * @returns Configuration object
     */
    private async getConfiguration(os: string) {
        const connectorPath = await this.getConnectorPath(os);
        const serverKey = getPrimaryServerKey(this.app.vault.getName());
        
        // Create server configuration
        const serverConfig = {
            command: "node",
            args: [connectorPath]
        };
        
        // Return different configurations based on setup type
        if (this.isFirstTimeSetup) {
            return {
                mcpServers: {
                    [serverKey]: serverConfig
                }
            };
        } else {
            return {
                [serverKey]: serverConfig
            };
        }
    }
    
    /**
     * Get the connector path for a specific OS
     * @param os Operating system (windows, mac, linux)
     * @returns Connector path
     */
    private async getConnectorPath(_os: string): Promise<string> {
        const vaultRoot = this.getVaultBasePath();
        const adapter = this.app.vault.adapter;
        const pluginFolders = getAllPluginIds();
        for (const folder of pluginFolders) {
            // Use vault-relative path for adapter checks
            const relativeConnectorPath = normalizePath(`.obsidian/plugins/${folder}/connector.js`);
            try {
                const exists = await adapter.exists(relativeConnectorPath);
                if (exists) {
                    // Prefer absolute path when available (desktop FileSystemAdapter)
                    if (vaultRoot) {
                        return path.join(vaultRoot, relativeConnectorPath);
                    }
                    return relativeConnectorPath;
                }
            } catch (error) {
                // Fall through and try next folder
            }
        }

        // Default to the primary folder even if we couldn't verify existence
        const fallbackRelative = normalizePath(`.obsidian/plugins/${pluginFolders[0]}/connector.js`);
        return vaultRoot ? path.join(vaultRoot, fallbackRelative) : fallbackRelative;
    }

    /**
     * Get a placeholder config synchronously for initial render
     * Updated asynchronously once paths resolve
     */
    private getConfigurationSyncPlaceholder() {
        const serverKey = getPrimaryServerKey(this.app.vault.getName());
        return {
            mcpServers: {
                [serverKey]: {
                    command: 'node',
                    args: ['<resolving connector path...>']
                }
            }
        };
    }

    /**
     * Populate tab config code block and copy handler once paths resolve
     */
    private async populateTabConfig(tabId: string, codeEl: HTMLElement, copyButton: HTMLButtonElement) {
        try {
            const config = await this.getConfiguration(tabId);
            codeEl.textContent = JSON.stringify(config, null, 2);
            copyButton.onclick = () => {
                navigator.clipboard.writeText(JSON.stringify(config, null, 2));
                copyButton.setText('Copied!');
                setTimeout(() => copyButton.setText('Copy Configuration'), 2000);
            };
        } catch (error) {
            console.error(`[ConfigModal] Failed to populate config for ${tabId}:`, error);
            codeEl.textContent = 'Failed to load configuration. See console for details.';
        }
    }

    /**
     * Resolve the vault's base filesystem path if available
     */
    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            return adapter.getBasePath();
        }
        return null;
    }
    
    /**
     * Get the Windows config path
     * @returns Windows config path
     */
    private getWindowsConfigPath(): string {
        return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    }
    
    /**
     * Get the Mac config path
     * @returns Mac config path
     */
    private getMacConfigPath(): string {
        return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    
    /**
     * Get the Linux config path
     * @returns Linux config path
     */
    private getLinuxConfigPath(): string {
        return path.join(process.env.HOME || '', '.config', 'Claude', 'claude_desktop_config.json');
    }
    
    /**
     * Called when the modal is closed
     */
    onClose() {
        this.component.unload();
        const { contentEl } = this;
        contentEl.empty();
    }
}
