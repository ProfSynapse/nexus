import { Setting, Notice } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { ServiceManager } from '../../core/ServiceManager';

export class DataTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private serviceManager: ServiceManager;
    private storageAdapter: IStorageAdapter | null = null;

    constructor(container: HTMLElement, router: SettingsRouter, serviceManager: ServiceManager) {
        this.container = container;
        this.router = router;
        this.serviceManager = serviceManager;
    }

    async render(): Promise<void> {
        this.container.empty();
        this.container.addClass('nexus-settings-tab-content');

        // Header
        this.container.createEl('h3', { text: 'Data management' });
        this.container.createEl('p', { 
            text: 'Manage your conversation data, exports, and backups.',
            cls: 'nexus-settings-desc'
        });

        // Initialize Storage Adapter
        await this.initStorageAdapter();

        // Export Section
        this.renderExportSection();
    }

    private async initStorageAdapter() {
        if (this.storageAdapter) return;

        try {
            // Try to get storageAdapter from ServiceManager
            // It might be registered as 'storageAdapter' or 'hybridStorage'
            // I'll try 'storageAdapter' first, then check if I can find it
            this.storageAdapter = await this.serviceManager.getService<IStorageAdapter>('storageAdapter');
        } catch (error) {
            console.error('Failed to initialize StorageAdapter:', error);
        }
    }

    private renderExportSection() {
        const section = this.container.createDiv('nexus-settings-section');
        section.createEl('h4', { text: 'Export' });

        new Setting(section)
            .setName('Export conversations')
            .setDesc('Export all conversations for fine tuning.')
            .addButton(button => button
                .setButtonText('Export dataset')
                .setIcon('download')
                .onClick(async () => {
                    if (!this.storageAdapter) {
                        new Notice('Storage adapter not available. Please try again later.');
                        await this.initStorageAdapter();
                        return;
                    }

                    button.setButtonText('Exporting...').setDisabled(true);
                    try {
                        const jsonl = await this.storageAdapter.exportConversationsForFineTuning();
                        
                        // Create a download
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
                        button.setButtonText('Export dataset').setDisabled(false);
                    }
                }));
    }
}
