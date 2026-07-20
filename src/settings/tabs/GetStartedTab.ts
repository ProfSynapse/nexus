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
import { CONNECTOR_JS_CONTENT } from '../../utils/connectorContent';
import { LocalCliInstaller, CliProviderId, CliInstallTargets } from '../../services/cli/LocalCliInstaller';
import {
    appendCodexMcpTomlSnippet,
    buildCodexMcpTomlSnippet,
    hasCodexMcpServerConfig
} from '../../utils/codexMcpConfig';

type GetStartedView = 'paths' | 'internal-chat' | 'mcp-setup';
type CodexConfigStatus = 'no-config-file' | 'nexus-configured' | 'config-exists';
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

interface ManualStepOptions {
    code: string;
    configLabel: string;
    configPath: string | null;
    known: boolean;
    restartText: string;
    summaryText?: string;
}

interface ConnectedCardOptions {
    configPath: string;
    configFileName: string;
    restartText: string;
}

export class GetStartedTab {
    private container: HTMLElement;
    private services: GetStartedTabServices;
    private currentView: GetStartedView = 'paths';
    private cachedNodePath: string | null = null;
    private justConnectedClaude = false;
    private justConnectedCodex = false;

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

        // "Just connected" confirmation cards only persist while on the MCP view.
        if (this.currentView !== 'mcp-setup') {
            this.justConnectedClaude = false;
            this.justConnectedCodex = false;
        }

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

        // Path 2: External agents (MCP clients + CLI coding agents)
        const mcpPath = paths.createDiv('nexus-setup-path');
        mcpPath.createDiv('nexus-setup-path-icon').setText('🔗');
        mcpPath.createDiv('nexus-setup-path-title').setText('External agents');
        mcpPath.createDiv('nexus-setup-path-desc').setText('Connect Claude Desktop, Codex, Cursor, and more');
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
     * Render External agents setup view (MCP clients + CLI coding agents)
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

        this.container.createEl('h3', { text: 'External agent setup' });

        // Setup requires Node.js modules (path, fs, child_process) — desktop only
        if (!Platform.isDesktop) {
            this.container.createEl('p', {
                text: 'External agent setup requires a desktop environment.',
                cls: 'setting-item-description'
            });
            return;
        }

        this.container.createEl('p', {
            text: 'Connect Nexus to external AI agents (Claude Desktop, Codex, Cursor, and more) so they can read and write your vault.',
            cls: 'setting-item-description'
        });

        this.renderConnectorExplainer();

        // Check for Node.js availability
        const nodePath = this.resolveNodePath();
        if (!nodePath) {
            this.renderNodeWarning();
        }

        const configPath = getClaudeDesktopConfigPath();
        if (!configPath) {
            this.container.createEl('p', {
                text: 'MCP setup is only available on desktop.',
                cls: 'setting-item-description'
            });
            return;
        }

        this.renderClaudeSection(configPath);

        this.container.createEl('hr', { cls: 'nexus-divider' });
        this.renderCodexSetupSection();

        this.container.createEl('hr', { cls: 'nexus-divider' });
        this.renderGenericAgentsSection();

        this.container.createEl('hr', { cls: 'nexus-divider' });
        this.renderLocalCliSection();
    }

    /**
     * Short explainer for what connector.js is and that one-click handles it.
     */
    private renderConnectorExplainer(): void {
        const box = this.container.createDiv('nexus-connector-explainer');
        box.createSpan({ text: '🔌', cls: 'nx-icon' });
        const p = box.createEl('p');
        p.createSpan({ text: 'External agents talk to your vault through a small bridge file, ' });
        p.createEl('code', { text: 'connector.js' });
        p.createSpan({ text: ', that Nexus keeps in this plugin’s folder. The one-click buttons below create it and wire it into each agent’s config for you. Prefer to do it by hand? Each agent has a “Set up manually” section with numbered steps.' });
    }

    /**
     * Node.js not found warning row.
     */
    private renderNodeWarning(): void {
        const component = this.services.component;
        const nodeWarning = this.container.createDiv('nexus-mcp-row nexus-mcp-node-warning');
        nodeWarning.createSpan({
            text: 'Node.js not found',
            cls: 'nexus-mcp-status nexus-mcp-warning'
        });
        const actions = nodeWarning.createDiv('nexus-mcp-actions');
        const downloadBtn = actions.createEl('button', { text: 'Install Node.js', cls: 'mod-cta' });
        if (component) {
            component.registerDomEvent(downloadBtn, 'click', () => window.open('https://nodejs.org', '_blank'));
        }
        const refreshBtn = actions.createEl('button', { text: 'Refresh' });
        if (component) {
            component.registerDomEvent(refreshBtn, 'click', () => this.render());
        }
        this.container.createEl('p', {
            text: 'Node.js is required to run the MCP connector. Install it, then click refresh.',
            cls: 'nexus-mcp-help'
        });
    }

    /**
     * Claude Desktop agent block: status-driven, with a manual fallback disclosure.
     */
    private renderClaudeSection(configPath: string): void {
        const block = this.container.createDiv('nexus-agent-block');
        const heading = block.createEl('h4');
        heading.createSpan({ text: '🟣 ', cls: 'nx-agent-logo' });
        heading.createSpan({ text: 'Claude Desktop' });

        const configStatus = this.checkConfigStatus();
        const component = this.services.component;

        if (configStatus === 'no-claude-folder') {
            const row = block.createDiv('nexus-mcp-row');
            row.createSpan({
                text: '⚠️ Claude Desktop not found',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });
            const actions = row.createDiv('nexus-mcp-actions');
            const downloadBtn = actions.createEl('button', { text: 'Download', cls: 'mod-cta' });
            if (component) {
                component.registerDomEvent(downloadBtn, 'click', () => window.open('https://claude.ai/download', '_blank'));
            }
            const refreshBtn = actions.createEl('button', { text: 'Refresh' });
            if (component) {
                component.registerDomEvent(refreshBtn, 'click', () => this.render());
            }
            block.createEl('p', {
                text: 'Install Claude Desktop, open it once, then enable settings → developer → MCP servers and click refresh.',
                cls: 'nexus-mcp-help'
            });
            return;
        }

        if (configStatus === 'nexus-configured') {
            if (this.justConnectedClaude) {
                this.renderJustConnectedCard(block, {
                    configPath,
                    configFileName: 'claude_desktop_config.json',
                    restartText: 'Fully quit and relaunch Claude Desktop to load it (a window reload isn’t enough).'
                });
            } else {
                this.renderConnectedCompact(block, configPath, 'Restart Claude Desktop if you haven’t already.');
            }
            return;
        }

        if (configStatus === 'invalid-config') {
            const row = block.createDiv('nexus-mcp-row');
            row.createSpan({
                text: '⚠️ config file is invalid or empty',
                cls: 'nexus-mcp-status nexus-mcp-warning'
            });
            const actions = row.createDiv('nexus-mcp-actions');
            const fixBtn = actions.createEl('button', { text: 'Fix config', cls: 'mod-cta' });
            if (component) {
                component.registerDomEvent(fixBtn, 'click', () => this.autoConfigureNexus(configPath));
            }
            const openBtn = actions.createEl('button', { text: 'Open config' });
            if (component) {
                component.registerDomEvent(openBtn, 'click', () => this.openConfigFile(configPath));
            }
            block.createEl('p', {
                text: 'The config file exists but has invalid JSON. Click “fix config” to overwrite it, or set it up manually below.',
                cls: 'nexus-mcp-help'
            });
            this.appendManualDisclosure(block, {
                code: this.getConfigJson(),
                configLabel: 'claude_desktop_config.json',
                configPath,
                known: true,
                restartText: 'Fully quit and relaunch Claude Desktop so it loads the new server.'
            });
            return;
        }

        // Ready to connect (no-config-file / claude-found)
        const row = block.createDiv('nexus-mcp-row');
        row.createSpan({ text: 'Ready to connect', cls: 'nexus-mcp-status' });
        const actions = row.createDiv('nexus-mcp-actions');
        const connectBtn = actions.createEl('button', { text: 'Connect Claude Desktop', cls: 'mod-cta' });
        if (component) {
            component.registerDomEvent(connectBtn, 'click', () => this.autoConfigureNexus(configPath));
        }
        this.appendManualDisclosure(block, {
            code: this.getConfigJson(),
            configLabel: 'claude_desktop_config.json',
            configPath,
            known: true,
            restartText: 'Fully quit and relaunch Claude Desktop so it loads the new server.'
        });
    }

    /**
     * Full "just connected" confirmation card, shown once right after a one-click connect.
     */
    private renderJustConnectedCard(parent: HTMLElement, opts: ConnectedCardOptions): void {
        const component = this.services.component;
        const connectorPath = this.getConnectorDisplayPath();

        const card = parent.createDiv('nexus-connect-result');
        const head = card.createDiv('nx-result-head');
        head.createSpan({ text: '✓ connected', cls: 'nx-result-title' });
        const actions = head.createDiv('nx-result-actions');
        const revealBtn = actions.createEl('button', { text: 'Reveal connector.js' });
        if (component) {
            component.registerDomEvent(revealBtn, 'click', () => this.revealInFolder(connectorPath));
        }
        const openBtn = actions.createEl('button', { text: 'Open config' });
        if (component) {
            component.registerDomEvent(openBtn, 'click', () => this.openConfigFile(opts.configPath));
        }

        const list = card.createEl('ul', { cls: 'nx-checklist' });

        const li1 = list.createEl('li');
        li1.createSpan({ text: '✓', cls: 'nx-check' });
        const li1body = li1.createSpan();
        li1body.createSpan({ text: 'Created bridge file', cls: 'nx-label' });
        li1body.createEl('br');
        li1body.createEl('code', { text: connectorPath });

        const li2 = list.createEl('li');
        li2.createSpan({ text: '✓', cls: 'nx-check' });
        const li2body = li2.createSpan();
        li2body.createSpan({ text: 'Added Nexus to ', cls: 'nx-label' });
        li2body.createEl('code', { text: opts.configFileName });

        const li3 = list.createEl('li');
        li3.createSpan({ text: '→', cls: 'nx-next' });
        li3.createSpan({ text: opts.restartText });
    }

    /**
     * Compact connected row, shown on revisits when already configured.
     */
    private renderConnectedCompact(parent: HTMLElement, configPath: string, restartText: string): void {
        const component = this.services.component;
        const row = parent.createDiv('nexus-mcp-row');
        row.createSpan({ text: '✓ connected', cls: 'nexus-mcp-status nexus-mcp-success' });
        const actions = row.createDiv('nexus-mcp-actions');
        const openBtn = actions.createEl('button', { text: 'Open config' });
        if (component) {
            component.registerDomEvent(openBtn, 'click', () => this.openConfigFile(configPath));
        }
        const revealBtn = actions.createEl('button', { text: this.getRevealButtonText() });
        if (component) {
            component.registerDomEvent(revealBtn, 'click', () => this.revealInFolder(configPath));
        }
        parent.createEl('p', { text: restartText, cls: 'nexus-mcp-help' });
    }

    /**
     * "Other agents" block: create the connector + a copyable entry + link to the guide.
     * Nexus does not know these tools' config paths, so no write/reveal is offered.
     */
    private renderGenericAgentsSection(): void {
        const block = this.container.createDiv('nexus-agent-block');
        const heading = block.createEl('h4');
        heading.createSpan({ text: '🧩 ', cls: 'nx-agent-logo' });
        heading.createSpan({ text: 'Other agents (Cursor, Cline, Gemini CLI, Copilot…)' });

        block.createEl('p', {
            text: 'Nexus works with any MCP client. Create the bridge file once, then paste the same server entry into that tool’s config.',
            cls: 'setting-item-description'
        });

        this.appendManualDisclosure(block, {
            code: this.getConfigJson(),
            configLabel: 'your agent’s MCP config',
            configPath: null,
            known: false,
            restartText: 'Most tools auto-reload MCP config; some need a restart. Check the setup guide if the server doesn’t appear.',
            summaryText: 'Show manual steps'
        });

        const helpP = block.createEl('p', { cls: 'nexus-mcp-help' });
        helpP.createSpan({ text: 'Need another tool? See the ' });
        const link = helpP.createEl('a', { text: 'MCP setup guide', href: '#' });
        const component = this.services.component;
        if (component) {
            component.registerDomEvent(link, 'click', (evt: MouseEvent) => {
                evt.preventDefault();
                window.open('https://github.com/ProfSynapse/nexus/blob/main/guide/mcp-setup.md', '_blank');
            });
        }
        helpP.createSpan({ text: ' for exact config locations per tool.' });
    }

    /**
     * Collapsible "Set up manually" disclosure with numbered steps.
     */
    private appendManualDisclosure(parent: HTMLElement, opts: ManualStepOptions): void {
        const details = parent.createEl('details', { cls: 'nexus-manual-details' });
        details.createEl('summary', { text: opts.summaryText ?? 'Set up manually instead' });
        const body = details.createDiv('nexus-manual-body');
        this.buildManualSteps(body, opts);
    }

    private addManualStep(body: HTMLElement, num: string, title: string): HTMLElement {
        const step = body.createDiv('nx-step');
        step.createDiv('nx-step-num').setText(num);
        const stepBody = step.createDiv('nx-step-body');
        stepBody.createEl('h5', { text: title });
        return stepBody;
    }

    private buildManualSteps(body: HTMLElement, opts: ManualStepOptions): void {
        const component = this.services.component;
        const connectorPath = this.getConnectorDisplayPath();

        // Step 1 — create connector.js
        const step1 = this.addManualStep(body, '1', 'Create the connector file');
        step1.createEl('p', {
            text: 'Generates connector.js in the plugin folder. Do this first — the config below points at it, and the agent fails silently if it’s missing.',
            cls: 'setting-item-description'
        });
        const createRow = step1.createDiv('nx-pathrow');
        const createBtn = createRow.createEl('button', { text: 'Create connector.js' });
        if (component) {
            component.registerDomEvent(createBtn, 'click', () => this.createConnectorFileWithNotice());
        }
        const pathRow = step1.createDiv('nx-pathrow');
        pathRow.createSpan({ text: connectorPath, cls: 'nx-inline-path' });

        // Step 2 — add config
        const step2 = this.addManualStep(body, '2', `Add this to ${opts.configLabel}`);
        step2.createEl('p', {
            text: opts.known
                ? 'Paste inside the existing config (merge into mcpServers if you already have servers).'
                : 'Paste this into your agent’s MCP config — each tool keeps it in a different place. See the setup guide below for exact locations.',
            cls: 'setting-item-description'
        });
        const codeBlock = step2.createEl('pre', { cls: 'nexus-config-code' });
        codeBlock.createEl('code', { text: opts.code });
        const copyRow = step2.createDiv('nx-pathrow');
        const copyBtn = copyRow.createEl('button', { text: 'Copy config' });
        if (component) {
            component.registerDomEvent(copyBtn, 'click', async () => {
                try {
                    await navigator.clipboard.writeText(opts.code);
                    copyBtn.textContent = 'Copied!';
                    window.setTimeout(() => { copyBtn.textContent = 'Copy config'; }, 2000);
                } catch {
                    new Notice('Failed to copy to clipboard');
                }
            });
        }
        if (opts.known && opts.configPath) {
            const revealBtn = copyRow.createEl('button', { text: 'Reveal config file' });
            const configPath = opts.configPath;
            if (component) {
                component.registerDomEvent(revealBtn, 'click', () => this.revealInFolder(configPath));
            }
        }

        // Step 3 — restart
        const step3 = this.addManualStep(body, '3', opts.known ? 'Restart the agent' : 'Restart your agent');
        step3.createEl('p', { text: opts.restartText, cls: 'setting-item-description' });
    }

    /**
     * Best-effort display path for connector.js (falls back to the bare filename).
     */
    private getConnectorDisplayPath(): string {
        try {
            const pathMod = this.loadDesktopModule('path');
            return this.getConnectorPath(pathMod);
        } catch {
            return 'connector.js';
        }
    }

    /**
     * Local CLI bridge: installs a machine-global `nexus` command + agent skill
     * so external coding agents (Claude Code, Codex) can drive the vault with no
     * MCP configuration. Everything lives outside the vault and is reversible.
     */
    private renderLocalCliSection(): void {
        const block = this.container.createDiv('nexus-agent-block');
        const heading = block.createEl('h4');
        heading.createSpan({ text: '⚡ ', cls: 'nx-agent-logo' });
        heading.createSpan({ text: 'Local CLI (no MCP required)' });

        block.createEl('p', {
            text: 'Installs a machine-global command-line tool so external coding agents can discover and run your vault’s tools directly — no MCP server entry to configure. Everything is installed outside your vault and is reversible.',
            cls: 'setting-item-description'
        });

        const installer = new LocalCliInstaller();
        if (!installer.isSupported()) {
            block.createEl('p', {
                text: 'The local CLI is available on desktop only.',
                cls: 'setting-item-description'
            });
            return;
        }

        // Keep an already-installed copy in sync with this plugin build.
        installer.reconcile();

        const status = installer.status();
        const component = this.services.component;

        const row = block.createDiv('nexus-mcp-row');
        const statusText = status.installed
            ? (status.onPath ? 'Installed and on your PATH' : 'Installed (not yet on your PATH)')
            : 'Not installed';
        row.createSpan({ text: statusText, cls: 'nexus-mcp-status' });

        const actions = row.createDiv('nexus-mcp-actions');

        // Provider picker — which agents to wire the nexus CLI into. Claude Code and
        // Cursor use the same skills mechanism (a symlink into their skills dir);
        // Codex gets an AGENTS.md pointer block.
        const providers: Array<{ id: CliProviderId; label: string; hint: string }> = [
            { id: 'claudeCode', label: 'Claude Code', hint: '~/.claude/skills' },
            { id: 'cursor', label: 'Cursor', hint: '~/.cursor/skills' },
            { id: 'codex', label: 'Codex', hint: '~/.codex/AGENTS.md' },
        ];
        const isLinked = (id: CliProviderId): boolean =>
            id === 'claudeCode' ? status.skillLinked
                : id === 'cursor' ? status.cursorLinked
                    : status.codexLinked;

        const picker = block.createDiv('nexus-cli-providers');
        picker.createEl('p', {
            text: status.installed
                ? 'Wire the nexus CLI into these agents — toggle any time:'
                : 'Choose which agents to wire the nexus CLI into:',
            cls: 'setting-item-description'
        });
        const checkboxes = new Map<CliProviderId, HTMLInputElement>();
        for (const prov of providers) {
            const detectedHere = status.detected[prov.id];
            const rowEl = picker.createDiv('nexus-cli-provider-row');
            const cb = rowEl.createEl('input', { attr: { type: 'checkbox' } });
            cb.checked = status.installed ? isLinked(prov.id) : detectedHere;
            const label = rowEl.createEl('label');
            label.createSpan({ text: prov.label });
            label.createSpan({
                text: detectedHere ? ` — ${prov.hint}` : ` — ${prov.hint} (not detected)`,
                cls: 'nexus-cli-provider-hint'
            });
            checkboxes.set(prov.id, cb);
            if (status.installed && component) {
                // Post-install: each toggle wires/unwires that provider immediately.
                component.registerDomEvent(cb, 'change', () => this.setCliProvider(installer, prov.id, prov.label, cb.checked));
            }
        }

        if (!status.installed) {
            const enableBtn = actions.createEl('button', { text: 'Install CLI', cls: 'mod-cta' });
            if (component) {
                component.registerDomEvent(enableBtn, 'click', () => {
                    const targets: Partial<CliInstallTargets> = {};
                    for (const [id, cb] of checkboxes) targets[id] = cb.checked;
                    this.enableLocalCli(installer, targets);
                });
            }
        } else {
            if (Platform.isWin && !status.onPath) {
                const pathBtn = actions.createEl('button', { text: 'Add to path', cls: 'mod-cta' });
                if (component) {
                    component.registerDomEvent(pathBtn, 'click', () => this.addLocalCliToPath(installer));
                }
            }
            const revealBtn = actions.createEl('button', { text: this.getRevealButtonText() });
            if (component) {
                component.registerDomEvent(revealBtn, 'click', () => this.revealInFolder(status.paths.cliJsPath));
            }
            const uninstallBtn = actions.createEl('button', { text: 'Uninstall' });
            if (component) {
                component.registerDomEvent(uninstallBtn, 'click', () => this.uninstallLocalCli(installer));
            }
        }

        const details = block.createEl('details', { cls: 'nexus-manual-details' });
        details.createEl('summary', { text: status.installed ? 'What’s installed' : 'What this installs' });
        const disclosureBody = details.createDiv('nexus-manual-body');
        for (const line of installer.describePlan()) {
            disclosureBody.createDiv('nx-pathrow').createSpan({ text: line, cls: 'nx-inline-path' });
        }
        disclosureBody.createEl('p', {
            text: 'All paths are outside your vault (nothing is synced), and everything here is reversible with uninstall.',
            cls: 'setting-item-description'
        });
    }

    private enableLocalCli(installer: LocalCliInstaller, targets?: Partial<CliInstallTargets>): void {
        try {
            const result = installer.enable(targets);
            const warn = result.warnings.length
                ? ` (${result.warnings.length} note${result.warnings.length === 1 ? '' : 's'})`
                : '';
            const terminalHint = Platform.isWin
                ? 'Open a new terminal, then run `nexus vaults`.'
                : 'Try running `nexus vaults` in your terminal.';
            new Notice(`Nexus CLI installed${warn}. ${terminalHint}`);
            for (const w of result.warnings) console.warn('[GetStartedTab] Local CLI:', w);
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error installing local CLI:', error);
            new Notice(`Failed to install local CLI: ${(error as Error).message}`);
        }
    }

    private addLocalCliToPath(installer: LocalCliInstaller): void {
        try {
            const result = installer.addToWindowsUserPath();
            for (const w of result.warnings) console.warn('[GetStartedTab] Local CLI:', w);
            new Notice(result.warnings.length
                ? 'Could not add Nexus CLI to PATH. See the developer console for details.'
                : 'Nexus CLI added to your user PATH. Open a new terminal to use it.');
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error adding local CLI to PATH:', error);
            new Notice(`Failed to add Nexus CLI to PATH: ${(error as Error).message}`);
        }
    }

    private setCliProvider(installer: LocalCliInstaller, id: CliProviderId, label: string, enabled: boolean): void {
        try {
            const result = installer.setProvider(id, enabled);
            for (const w of result.warnings) console.warn('[GetStartedTab] Local CLI:', w);
            new Notice(enabled ? `Wired nexus into ${label}.` : `Removed nexus from ${label}.`);
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error updating CLI provider:', error);
            new Notice(`Failed to update ${label}: ${(error as Error).message}`);
        }
    }

    private uninstallLocalCli(installer: LocalCliInstaller): void {
        try {
            installer.uninstall();
            new Notice('Nexus CLI uninstalled.');
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error uninstalling local CLI:', error);
            new Notice(`Failed to uninstall local CLI: ${(error as Error).message}`);
        }
    }

    private renderCodexSetupSection(): void {
        const block = this.container.createDiv('nexus-agent-block');
        const heading = block.createEl('h4');
        heading.createSpan({ text: '⬛ ', cls: 'nx-agent-logo' });
        heading.createSpan({ text: 'Codex' });

        const nodeFs = this.loadDesktopModule('fs');
        const pathMod = this.loadDesktopModule('path');
        const configPath = this.getCodexConfigPath(pathMod);
        const nodePath = this.resolveNodePath();
        const configStatus = this.getCodexConfigStatus(nodeFs, configPath);
        const component = this.services.component;

        if (configStatus === 'nexus-configured') {
            if (this.justConnectedCodex) {
                this.renderJustConnectedCard(block, {
                    configPath,
                    configFileName: 'config.toml',
                    restartText: 'Start a new Codex session to load it.'
                });
            } else {
                this.renderConnectedCompact(block, configPath, 'Restart Codex or start a new session if Nexus does not appear.');
            }
            return;
        }

        const row = block.createDiv('nexus-mcp-row');
        row.createSpan({ text: 'Ready to connect', cls: 'nexus-mcp-status' });
        const actions = row.createDiv('nexus-mcp-actions');
        const connectBtn = actions.createEl('button', { text: 'Connect Codex', cls: 'mod-cta' });
        if (!nodePath) {
            connectBtn.disabled = true;
        }
        if (component) {
            component.registerDomEvent(connectBtn, 'click', () => this.autoConfigureCodex());
        }

        this.appendManualDisclosure(block, {
            code: this.getCodexConfigToml(),
            configLabel: '~/.codex/config.toml',
            configPath,
            known: true,
            restartText: 'Start a new Codex session (config is picked up on launch).'
        });
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

        const maybeRequire = (window.activeWindow as Window & {
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

    private getCodexConfigPath(pathMod: DesktopModuleMap['path']): string {
        const codexHome = process.env.CODEX_HOME || pathMod.join(this.getUserHome(), '.codex');
        return pathMod.normalize(pathMod.join(codexHome, 'config.toml'));
    }

    private getUserHome(): string {
        if (Platform.isWin) {
            return process.env.USERPROFILE || process.env.HOME || '';
        }

        return process.env.HOME || '';
    }

    private getCodexConfigStatus(
        nodeFs: DesktopModuleMap['fs'],
        configPath: string
    ): CodexConfigStatus {
        if (!nodeFs.existsSync(configPath)) {
            return 'no-config-file';
        }

        try {
            const content = nodeFs.readFileSync(configPath, 'utf-8');
            const serverKey = getPrimaryServerKey(this.services.app.vault.getName());

            if (hasCodexMcpServerConfig(content, serverKey)) {
                return 'nexus-configured';
            }
        } catch (error) {
            console.error('[GetStartedTab] Error reading Codex config:', error);
        }

        return 'config-exists';
    }

    private getCodexConfigToml(): string {
        const pathMod = this.loadDesktopModule('path');
        const vaultName = this.services.app.vault.getName();
        const serverKey = getPrimaryServerKey(vaultName);
        const connectorPath = pathMod.normalize(pathMod.join(this.services.pluginPath, 'connector.js'));
        const nodePath = this.resolveNodePath() || 'node';

        return buildCodexMcpTomlSnippet(serverKey, nodePath, [connectorPath]);
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
            const connectorPath = this.ensureConnectorFile(nodeFs, pathMod);
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

            new Notice('Nexus connector created and added to Claude Desktop config. Please restart Claude Desktop.');

            // Show the "just connected" confirmation card on the next render.
            this.justConnectedClaude = true;

            // Re-render to show updated status
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error auto-configuring:', error);
            new Notice(`Failed to configure: ${(error as Error).message}`);
        }
    }

    private autoConfigureCodex(): void {
        const nodeFs = this.loadDesktopModule('fs');
        const pathMod = this.loadDesktopModule('path');

        try {
            const nodePath = this.resolveNodePath();

            if (!nodePath) {
                new Notice('Node.js not found. Please install Node.js and try again.');
                return;
            }

            const vaultName = this.services.app.vault.getName();
            const serverKey = getPrimaryServerKey(vaultName);
            const connectorPath = this.ensureConnectorFile(nodeFs, pathMod);
            const configPath = this.getCodexConfigPath(pathMod);
            const configDir = pathMod.dirname(configPath);
            const configToml = buildCodexMcpTomlSnippet(serverKey, nodePath, [connectorPath]);

            if (!nodeFs.existsSync(configDir)) {
                nodeFs.mkdirSync(configDir, { recursive: true });
            }

            if (!nodeFs.existsSync(configPath)) {
                nodeFs.writeFileSync(configPath, `${configToml}\n`, 'utf-8');
                new Notice('Nexus connector added to the app config. Restart the app or start a new session if needed.');
                this.justConnectedCodex = true;
                this.render();
                return;
            }

            const existingContent = nodeFs.readFileSync(configPath, 'utf-8');
            if (hasCodexMcpServerConfig(existingContent, serverKey)) {
                new Notice('Nexus is already configured in the app config.');
                this.render();
                return;
            }

            const updatedContent = appendCodexMcpTomlSnippet(existingContent, configToml);
            nodeFs.writeFileSync(configPath, updatedContent, 'utf-8');
            new Notice('Nexus connector added to the app config. Restart the app or start a new session if needed.');
            this.justConnectedCodex = true;
            this.render();
        } catch (error) {
            console.error('[GetStartedTab] Error auto-configuring Codex:', error);
            new Notice(`Failed to configure Codex: ${(error as Error).message}`);
        }
    }

    private getConnectorPath(pathMod: DesktopModuleMap['path']): string {
        if (!this.services.pluginPath) {
            throw new Error('Plugin path is unavailable.');
        }
        return pathMod.normalize(pathMod.join(this.services.pluginPath, 'connector.js'));
    }

    private ensureConnectorFile(
        nodeFs: DesktopModuleMap['fs'],
        pathMod: DesktopModuleMap['path']
    ): string {
        const connectorPath = this.getConnectorPath(pathMod);
        const pluginDir = pathMod.dirname(connectorPath);

        if (!nodeFs.existsSync(pluginDir)) {
            nodeFs.mkdirSync(pluginDir, { recursive: true });
        }

        if (nodeFs.existsSync(connectorPath)) {
            const existingContent = nodeFs.readFileSync(connectorPath, 'utf-8');
            if (existingContent === CONNECTOR_JS_CONTENT) {
                return connectorPath;
            }
        }

        nodeFs.writeFileSync(connectorPath, CONNECTOR_JS_CONTENT, 'utf-8');
        return connectorPath;
    }

    private createConnectorFileWithNotice(): void {
        try {
            const nodeFs = this.loadDesktopModule('fs');
            const pathMod = this.loadDesktopModule('path');
            const connectorPath = this.ensureConnectorFile(nodeFs, pathMod);
            new Notice(`Connector file created: ${connectorPath}`);
        } catch (error) {
            console.error('[GetStartedTab] Error creating connector file:', error);
            new Notice(`Failed to create connector file: ${(error as Error).message}`);
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
