import {
    App,
    ButtonComponent,
    Component,
    Modal,
    Notice,
    Setting,
    TextAreaComponent,
    TextComponent,
    ToggleComponent
} from 'obsidian';
import type { Plugin } from 'obsidian';
import {
    ClaudeHeadlessService,
    type ClaudeHeadlessPreflightResult,
    type ClaudeHeadlessRunResult
} from '../../services/external/ClaudeHeadlessService';

export class ClaudeHeadlessModal extends Modal {
    private readonly service: ClaudeHeadlessService;
    private promptValue = '';
    private modelValue = 'sonnet';
    private maxTurnsValue = '8';
    private bypassPermissions = true;
    private isRunning = false;

    private promptInput: TextAreaComponent | null = null;
    private statusEl: HTMLDivElement | null = null;
    private outputEl: HTMLPreElement | null = null;
    private runButton: ButtonComponent | null = null;
    private copyButton: ButtonComponent | null = null;

    constructor(app: App, plugin: Plugin) {
        super(app);
        this.service = new ClaudeHeadlessService(app, plugin);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('nexus-claude-headless-modal');

        contentEl.createEl('h2', { text: 'Experimental Claude headless session' });
        contentEl.createEl('p', {
            text: 'This launches your local Claude Code CLI in print mode, restricts built-in tools, and exposes only the Nexus MCP server for this vault.',
            cls: 'setting-item-description'
        });

        this.statusEl = contentEl.createDiv('nexus-claude-headless-status');
        this.setStatus('Checking Claude installation and auth status…', 'muted');

        const promptSetting = new Setting(contentEl)
            .setName('Prompt')
            .setDesc('Cmd/Ctrl+Enter runs the session.');
        this.promptInput = new TextAreaComponent(promptSetting.controlEl);
        this.promptInput.setPlaceholder('Ask Claude to inspect, edit, or organize your vault through Nexus MCP tools.');
        this.promptInput.setValue(this.promptValue);
        this.promptInput.inputEl.rows = 8;
        this.promptInput.inputEl.addClass('nexus-claude-headless-prompt');
        this.registerModalDomEvent(this.promptInput.inputEl, 'keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void this.runClaudeSession();
            }
        });

        new Setting(contentEl)
            .setName('Model')
            .setDesc('Claude model alias or full name passed to the local CLI.')
            .addText((text: TextComponent) => {
                text
                    .setPlaceholder('sonnet')
                    .setValue(this.modelValue)
                    .onChange((value) => {
                        this.modelValue = value;
                    });
            });

        new Setting(contentEl)
            .setName('Max turns')
            .setDesc('Agentic turn cap for print mode.')
            .addText((text: TextComponent) => {
                text
                    .setPlaceholder('8')
                    .setValue(this.maxTurnsValue)
                    .onChange((value) => {
                        this.maxTurnsValue = value;
                    });
            });

        new Setting(contentEl)
            .setName('Bypass permissions')
            .setDesc('Recommended for print mode so Nexus MCP tool calls do not stop on permission prompts.')
            .addToggle((toggle: ToggleComponent) => {
                toggle
                    .setValue(this.bypassPermissions)
                    .onChange((value) => {
                        this.bypassPermissions = value;
                    });
            });

        contentEl.createEl('h3', { text: 'Output' });
        this.outputEl = contentEl.createEl('pre', { cls: 'nexus-claude-headless-output' });
        this.outputEl.setText('No run yet.');

        const buttonRow = contentEl.createDiv('nexus-claude-headless-buttons');

        this.copyButton = new ButtonComponent(buttonRow)
            .setButtonText('Copy output')
            .setDisabled(true);
        this.registerModalDomEvent(this.copyButton.buttonEl, 'click', () => {
            const output = this.outputEl?.textContent?.trim();
            if (!output) {
                return;
            }
            void navigator.clipboard.writeText(output);
            new Notice('Claude output copied to clipboard.');
        });

        new ButtonComponent(buttonRow)
            .setButtonText('Close')
            .onClick(() => {
                this.close();
            });

        this.runButton = new ButtonComponent(buttonRow)
            .setButtonText('Run Claude')
            .setCta()
            .onClick(() => {
                void this.runClaudeSession();
            });

        void this.loadPreflightStatus();

        window.setTimeout(() => {
            this.promptInput?.inputEl.focus();
        }, 0);
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private registerModalDomEvent<K extends keyof HTMLElementEventMap>(
        element: HTMLElement,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void
    ): void {
        (this as unknown as Component).registerDomEvent(element, type, handler as EventListener);
    }

    private async loadPreflightStatus(): Promise<void> {
        const preflight = await this.service.getPreflight();
        this.setStatus(this.formatPreflight(preflight), preflight.isAuthenticated ? 'success' : 'warning');
    }

    private async runClaudeSession(): Promise<void> {
        if (this.isRunning) {
            return;
        }

        const prompt = this.promptInput?.getValue().trim() ?? '';
        if (!prompt) {
            new Notice('Enter a prompt first.');
            this.promptInput?.inputEl.focus();
            return;
        }

        this.isRunning = true;
        this.setButtonsDisabled(true);
        this.setStatus('Running Claude headless session…', 'muted');
        if (this.outputEl) {
            this.outputEl.setText('Running…');
        }

        const maxTurns = Number.parseInt(this.maxTurnsValue, 10);
        const result = await this.service.run({
            prompt,
            model: this.modelValue,
            maxTurns: Number.isFinite(maxTurns) ? maxTurns : 8,
            bypassPermissions: this.bypassPermissions
        });

        this.renderResult(result);
        this.setButtonsDisabled(false);
        this.isRunning = false;
    }

    private renderResult(result: ClaudeHeadlessRunResult): void {
        const outputParts = [
            result.stdout.trim(),
            result.stderr.trim() ? `STDERR:\n${result.stderr.trim()}` : '',
            result.commandLine ? `Command:\n${result.commandLine}` : ''
        ].filter(Boolean);

        if (this.outputEl) {
            this.outputEl.setText(outputParts.join('\n\n') || 'Claude returned no output.');
        }

        this.copyButton?.setDisabled(outputParts.length === 0);

        const durationSeconds = (result.durationMs / 1000).toFixed(1);
        if (result.success) {
            this.setStatus(`Completed in ${durationSeconds}s.`, 'success');
            new Notice('Claude headless session completed.');
            return;
        }

        const authHint = result.preflight.isAuthenticated
            ? ''
            : ' Claude is not logged in locally. Run `claude auth login` in your terminal, then try again.';
        this.setStatus(`Run failed after ${durationSeconds}s.${authHint}`, 'error');
        new Notice('Claude headless session failed. Review the output in the modal.');
    }

    private setButtonsDisabled(isDisabled: boolean): void {
        this.runButton?.setDisabled(isDisabled);
        if (isDisabled) {
            this.copyButton?.setDisabled(true);
        }
    }

    private setStatus(message: string, tone: 'muted' | 'success' | 'warning' | 'error'): void {
        if (!this.statusEl) {
            return;
        }

        this.statusEl.setText(message);
        this.statusEl.removeClass(
            'nexus-claude-headless-status-muted',
            'nexus-claude-headless-status-success',
            'nexus-claude-headless-status-warning',
            'nexus-claude-headless-status-error'
        );
        this.statusEl.addClass(`nexus-claude-headless-status-${tone}`);
    }

    private formatPreflight(preflight: ClaudeHeadlessPreflightResult): string {
        const details = [
            `Claude: ${preflight.claudePath ?? 'not found'}`,
            `Node: ${preflight.nodePath ?? 'not found'}`,
            `Connector: ${preflight.connectorPath ?? 'not found'}`,
            `Auth: ${preflight.authStatusText}`
        ];

        return details.join('\n');
    }
}
