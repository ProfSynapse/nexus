import { App, ButtonComponent, Notice, Setting } from 'obsidian';
import { Settings } from '../../settings';
import type { ServiceManager } from '../../core/ServiceManager';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { resolveVaultRoot } from '../../database/storage/VaultRootResolver';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import { changeDataFolderPath } from '../storage/changeDataFolderPath';

export interface DataTabServices {
    app: App;
    settings: Settings;
    serviceManager?: ServiceManager;
}

export class DataTab {
    private container: HTMLElement;
    private services: DataTabServices;
    private storageAdapter: IStorageAdapter | null = null;
    private storageRootInput: HTMLInputElement | null = null;
    private storageRootValueEl: HTMLInputElement | null = null;
    private storageRootButton: ButtonComponent | null = null;

    constructor(container: HTMLElement, services: DataTabServices) {
        this.container = container;
        this.services = services;
    }

    render(): void {
        void this.initStorageAdapter();

        this.container.empty();
        this.container.addClass('nexus-settings-tab-content');

        this.container.createEl('h3', { text: 'Data management' });
        this.container.createEl('p', {
            text: 'Manage your conversation data, exports, and backups.',
            cls: 'nexus-settings-desc'
        });

        this.renderExportSection();
        this.renderStorageSection();
    }

    destroy(): void {
        this.storageAdapter = null;
        this.storageRootInput = null;
        this.storageRootValueEl = null;
        this.storageRootButton = null;
    }

    private async initStorageAdapter(): Promise<void> {
        if (this.storageAdapter || !this.services.serviceManager) {
            return;
        }

        try {
            this.storageAdapter = await this.services.serviceManager.getService<IStorageAdapter>('hybridStorageAdapter');
        } catch (error) {
            console.error('[DataTab] Failed to initialize storage adapter:', error);
        }
    }

    private renderExportSection(): void {
        const section = this.container.createDiv('csr-section');
        section.createDiv('csr-section-header').setText('Export');
        const content = section.createDiv('csr-section-content');

        new Setting(content)
            .setName('Export conversations')
            .setDesc('Export the conversation dataset for backups or fine-tuning.')
            .addButton(button => button
                .setButtonText('Export dataset')
                .setIcon('download')
                .onClick(() => {
                    void this.handleExport(button);
                }));
    }

    private async handleExport(button: ButtonComponent): Promise<void> {
        if (!this.storageAdapter) {
            await this.initStorageAdapter();
        }

        if (!this.storageAdapter) {
            new Notice('Storage adapter is not available. Please try again later.');
            return;
        }

        button.setButtonText('Exporting dataset...').setDisabled(true);
        try {
            const jsonl = await this.storageAdapter.exportConversationsForFineTuning();
            const blob = new Blob([jsonl], { type: 'application/jsonl' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `assistant-data-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            new Notice('Export complete.');
        } catch (error) {
            console.error('[DataTab] Export failed:', error);
            new Notice('Export failed. Check the console for details.');
        } finally {
            button.setButtonText('Export dataset').setDisabled(false);
        }
    }

    private renderStorageSection(): void {
        const storageRoot = resolveVaultRoot(this.services.settings.settings, {
            configDir: this.services.app.vault.configDir
        });

        const section = this.container.createDiv('csr-section');
        section.createDiv('csr-section-header').setText('Storage');
        const content = section.createDiv('csr-section-content');

        content.createEl('p', {
            text: 'Conversation and workspace event data live in a vault folder. The SQLite cache stays local in plugin data.',
            cls: 'csr-section-desc'
        });

        new Setting(content)
            .setName('Current data folder')
            .setDesc('This is the active path for synced event files.')
            .addText(text => {
                text.setDisabled(true);
                text.setValue(storageRoot.resolvedPath);
                text.inputEl.readOnly = true;
                this.storageRootValueEl = text.inputEl;
            });

        new Setting(content)
            .setName('Data folder path')
            .setDesc('Use a vault-relative path. Hidden folders may not sync reliably.')
            .addText(text => {
                this.storageRootInput = text.inputEl;
                text.setPlaceholder('Nexus');
                text.setValue(storageRoot.configuredPath);
            })
            .addButton(button => {
                this.storageRootButton = button;
                button.setButtonText('Apply folder');
                button.setCta();
                button.onClick(() => {
                    void this.handleStorageRootChange();
                });
            });
    }

    private async handleStorageRootChange(): Promise<void> {
        const inputPath = this.storageRootInput?.value.trim() || this.services.settings.settings.storage?.rootPath || DEFAULT_STORAGE_SETTINGS.rootPath;

        this.storageRootButton?.setDisabled(true);
        try {
            const result = await changeDataFolderPath({
                app: this.services.app,
                settings: this.services.settings,
                serviceManager: this.services.serviceManager,
                nextRootPath: inputPath
            });

            if (!result.success) {
                new Notice(`Data folder update failed: ${result.message}`);
                return;
            }

            if (result.normalizedRootPath) {
                const storageRootInput = this.storageRootInput;
                if (storageRootInput) {
                    storageRootInput.value = result.normalizedRootPath;
                }
                if (this.storageRootValueEl) {
                    this.storageRootValueEl.value = result.normalizedRootPath;
                }
            }

            new Notice(result.message);
            if (result.warnings.length > 0) {
                new Notice(result.warnings[0]);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Data folder update failed: ${message}`);
        } finally {
            this.storageRootButton?.setDisabled(false);
        }
    }
}
