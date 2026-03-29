import { Setting, Notice, TextComponent, ButtonComponent } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { ServiceManager } from '../../core/ServiceManager';
import { UsageTracker, UsageData } from '../../services/UsageTracker';

export class DataTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private serviceManager: ServiceManager;
    private storageAdapter: IStorageAdapter | null = null;
    private usageTracker: UsageTracker;
    private viewMode: 'monthly' | 'allTime' = 'monthly';

    constructor(container: HTMLElement, router: SettingsRouter, serviceManager: ServiceManager) {
        this.container = container;
        this.router = router;
        this.serviceManager = serviceManager;
        this.usageTracker = new UsageTracker('llm', {});
    }

    async render(): Promise<void> {
        this.container.empty();
        this.container.addClass('nexus-settings-tab-content');

        this.container.createEl('h3', { text: 'Data dashboard' });

        await this.initStorageAdapter();

        const usageData = await this.usageTracker.getUsageData();

        this.renderBudgetMeter(usageData);
        this.renderSpendingByProvider(usageData);
        this.renderActions();
    }

    private async initStorageAdapter(): Promise<void> {
        if (this.storageAdapter) return;
        try {
            this.storageAdapter = await this.serviceManager.getService<IStorageAdapter>('storageAdapter');
        } catch {
            // Will be null, handled in action handlers
        }
    }

    // ── Budget meter ──────────────────────────────────────────────

    private renderBudgetMeter(usage: UsageData): void {
        const section = this.container.createDiv('nexus-data-section');
        section.createEl('h4', { text: 'Monthly budget' });

        const budget = this.usageTracker.getMonthlyBudget();
        const spent = usage.monthlyTotal;

        const meterContainer = section.createDiv('nexus-budget-meter');

        // Summary row
        const summaryRow = meterContainer.createDiv('nexus-budget-summary');
        summaryRow.createSpan({
            text: `$${spent.toFixed(2)} spent`,
            cls: 'nexus-budget-spent'
        });
        if (budget > 0) {
            summaryRow.createSpan({
                text: `$${budget.toFixed(2)} budget`,
                cls: 'nexus-budget-limit'
            });
        } else {
            summaryRow.createSpan({
                text: 'No budget set',
                cls: 'nexus-budget-limit'
            });
        }

        // Progress bar
        const barTrack = meterContainer.createDiv('nexus-budget-bar-track');
        const barFill = barTrack.createDiv('nexus-budget-bar-fill');
        const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
        barFill.addClass(pct > 90 ? 'over' : pct > 70 ? 'warning' : 'ok');
        // Dynamic width is the one justified inline style (like progress bars noted in CLAUDE.md)
        barFill.style.width = `${pct}%`;

        // All-time total
        const allTimeRow = meterContainer.createDiv('nexus-budget-alltime');
        allTimeRow.createSpan({
            text: `All-time: $${usage.allTimeTotal.toFixed(2)}`,
            cls: 'nexus-text-muted'
        });

        // Budget setting
        new Setting(section)
            .setName('Monthly budget')
            .setDesc('Set a monthly spending limit (0 = no limit)')
            .addText((text: TextComponent) => text
                .setPlaceholder('0.00')
                .setValue(budget > 0 ? budget.toString() : '')
                .onChange((val: string) => {
                    const num = parseFloat(val);
                    this.usageTracker.setMonthlyBudget(isNaN(num) ? 0 : num);
                }));
    }

    // ── Spending by provider chart ────────────────────────────────

    private renderSpendingByProvider(usage: UsageData): void {
        const section = this.container.createDiv('nexus-data-section');

        const headerRow = section.createDiv('nexus-chart-header');
        headerRow.createEl('h4', { text: 'Spending by provider' });

        // Toggle monthly / all-time
        const toggle = headerRow.createDiv('nexus-chart-toggle');
        const monthlyBtn = toggle.createEl('button', { text: 'Month', cls: 'nexus-toggle-btn' });
        const allTimeBtn = toggle.createEl('button', { text: 'All time', cls: 'nexus-toggle-btn' });

        const chartContainer = section.createDiv('nexus-provider-chart');

        const renderBars = (mode: 'monthly' | 'allTime') => {
            this.viewMode = mode;
            monthlyBtn.toggleClass('active', mode === 'monthly');
            allTimeBtn.toggleClass('active', mode === 'allTime');

            chartContainer.empty();

            const data = mode === 'monthly' ? usage.monthly : usage.allTime;
            const entries = Object.entries(data)
                .filter(([, cost]) => cost > 0)
                .sort((a, b) => b[1] - a[1]);

            if (entries.length === 0) {
                chartContainer.createDiv({
                    text: 'No spending data yet',
                    cls: 'nexus-chart-empty'
                });
                return;
            }

            const maxCost = entries[0][1];

            for (const [provider, cost] of entries) {
                const row = chartContainer.createDiv('nexus-bar-row');

                const label = row.createDiv('nexus-bar-label');
                label.createSpan({ text: this.formatProviderName(provider) });
                label.createSpan({ text: `$${cost.toFixed(2)}`, cls: 'nexus-bar-cost' });

                const barTrack = row.createDiv('nexus-bar-track');
                const barFill = barTrack.createDiv('nexus-bar-fill');
                // Dynamic width for chart bars (justified inline style)
                barFill.style.width = `${(cost / maxCost) * 100}%`;
            }
        };

        monthlyBtn.addEventListener('click', () => renderBars('monthly'));
        allTimeBtn.addEventListener('click', () => renderBars('allTime'));

        renderBars(this.viewMode);
    }

    // ── Actions ───────────────────────────────────────────────────

    private renderActions(): void {
        const section = this.container.createDiv('nexus-data-section');
        section.createEl('h4', { text: 'Actions' });

        // Export
        new Setting(section)
            .setName('Export conversations')
            .setDesc('Download all conversations as ChatML JSONL (OpenAI fine-tuning format)')
            .addButton((button: ButtonComponent) => button
                .setButtonText('Export')
                .setIcon('download')
                .onClick(async () => {
                    if (!this.storageAdapter) {
                        new Notice('Storage not ready. Please try again.');
                        await this.initStorageAdapter();
                        return;
                    }
                    button.setButtonText('Exporting...').setDisabled(true);
                    try {
                        const jsonl = await this.storageAdapter.exportConversationsForFineTuning();
                        const blob = new Blob([jsonl], { type: 'application/jsonl' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `nexus-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        new Notice('Export complete!');
                    } catch (error) {
                        console.error('Export failed:', error);
                        new Notice('Export failed. Check console for details.');
                    } finally {
                        button.setButtonText('Export').setDisabled(false);
                    }
                }));

        // Rebuild cache
        new Setting(section)
            .setName('Rebuild SQLite cache')
            .setDesc('Rebuild the local cache from JSONL source files. Use if data appears missing or stale.')
            .addButton((button: ButtonComponent) => button
                .setButtonText('Rebuild')
                .setIcon('refresh-cw')
                .onClick(async () => {
                    if (!this.storageAdapter) {
                        new Notice('Storage not ready. Please try again.');
                        await this.initStorageAdapter();
                        return;
                    }
                    button.setButtonText('Rebuilding...').setDisabled(true);
                    try {
                        await this.storageAdapter.sync();
                        new Notice('Cache rebuilt successfully!');
                    } catch (error) {
                        console.error('Cache rebuild failed:', error);
                        new Notice('Rebuild failed. Check console for details.');
                    } finally {
                        button.setButtonText('Rebuild').setDisabled(false);
                    }
                }));

        // Reset monthly usage
        new Setting(section)
            .setName('Reset monthly usage')
            .setDesc('Clear the current month\'s spending data. All-time totals are preserved.')
            .addButton((button: ButtonComponent) => button
                .setButtonText('Reset')
                .setWarning()
                .onClick(async () => {
                    await this.usageTracker.resetMonthlyUsage();
                    new Notice('Monthly usage reset.');
                    await this.render();
                }));
    }

    // ── Helpers ───────────────────────────────────────────────────

    private formatProviderName(provider: string): string {
        // Capitalize and clean up provider IDs like "openai" → "OpenAI"
        const nameMap: Record<string, string> = {
            openai: 'OpenAI',
            anthropic: 'Anthropic',
            google: 'Google',
            openrouter: 'OpenRouter',
            groq: 'Groq',
            mistral: 'Mistral',
            perplexity: 'Perplexity',
            githubcopilot: 'GitHub Copilot',
            'github-copilot': 'GitHub Copilot',
            webllm: 'WebLLM',
            ollama: 'Ollama',
            lmstudio: 'LM Studio',
            'lm-studio': 'LM Studio',
            'claude-code': 'Claude Code',
            'gemini-cli': 'Gemini CLI',
        };
        return nameMap[provider.toLowerCase()] || provider;
    }

    destroy(): void {
        // No timers or subscriptions to clean up
    }
}
