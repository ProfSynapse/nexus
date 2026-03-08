/**
 * AppConfigModal — Modal for configuring app credentials.
 * Renders input fields from the app's manifest.credentials declaration.
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import { AppManifest } from '../types/apps/AppTypes';

export interface AppConfigModalConfig {
  manifest: AppManifest;
  credentials: Record<string, string>;
  onSave: (credentials: Record<string, string>) => Promise<void>;
  onUninstall?: () => Promise<void>;
  onValidate?: () => Promise<{ success: boolean; error?: string; data?: unknown }>;
}

export class AppConfigModal extends Modal {
  private config: AppConfigModalConfig;
  private currentCredentials: Record<string, string>;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, config: AppConfigModalConfig) {
    super(app);
    this.config = config;
    this.currentCredentials = { ...config.credentials };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('app-config-modal');

    // Title
    contentEl.createEl('h2', { text: this.config.manifest.name });
    contentEl.createEl('p', {
      text: this.config.manifest.description,
      cls: 'setting-item-description'
    });

    // Docs link
    if (this.config.manifest.docsUrl) {
      contentEl.createEl('a', {
        text: 'Documentation',
        href: this.config.manifest.docsUrl,
        cls: 'app-config-docs-link'
      });
    }

    // Credential fields
    for (const cred of this.config.manifest.credentials) {
      new Setting(contentEl)
        .setName(cred.label + (cred.required ? ' *' : ''))
        .setDesc(cred.description || '')
        .addText(text => {
          text
            .setPlaceholder(cred.placeholder || '')
            .setValue(this.currentCredentials[cred.key] || '')
            .onChange((value) => {
              this.currentCredentials[cred.key] = value;
              this.debounceSave();
            });

          // Use password masking for sensitive fields
          if (cred.type === 'password') {
            text.inputEl.type = 'password';
          }
        });
    }

    // Save status
    const statusEl = contentEl.createDiv('app-config-status');
    statusEl.setText('Ready');

    // Action buttons
    const buttonContainer = contentEl.createDiv('app-config-buttons');

    // Validate button
    if (this.config.onValidate) {
      const validateBtn = buttonContainer.createEl('button', { text: 'Validate' });
      validateBtn.addEventListener('click', async () => {
        validateBtn.disabled = true;
        validateBtn.setText('Validating...');
        try {
          // Save first to ensure credentials are persisted
          await this.config.onSave(this.currentCredentials);
          const result = await this.config.onValidate!();
          if (result.success) {
            const missing = (result.data != null && typeof result.data === 'object' && 'missingPermissions' in result.data)
              ? (result.data as { missingPermissions: unknown }).missingPermissions
              : undefined;
            if (Array.isArray(missing) && missing.length > 0) {
              const msg = `Valid, but missing permissions: ${missing.join(', ')}`;
              new Notice(`${this.config.manifest.name}: ${msg}`);
              statusEl.setText(msg);
              statusEl.className = 'app-config-status app-config-status-warning';
            } else {
              new Notice(`${this.config.manifest.name}: credentials valid`);
              statusEl.setText('Valid ✓');
              statusEl.className = 'app-config-status app-config-status-success';
            }
          } else {
            new Notice(`${this.config.manifest.name}: ${result.error || 'validation failed'}`);
            statusEl.setText(result.error || 'Validation failed');
            statusEl.className = 'app-config-status app-config-status-error';
          }
        } catch (error) {
          new Notice(`Validation error: ${error}`);
        } finally {
          validateBtn.disabled = false;
          validateBtn.setText('Validate');
        }
      });
    }

    // Uninstall button
    if (this.config.onUninstall) {
      const uninstallBtn = buttonContainer.createEl('button', {
        text: 'Uninstall',
        cls: 'mod-warning'
      });
      uninstallBtn.addEventListener('click', async () => {
        await this.config.onUninstall!();
        this.close();
      });
    }
  }

  private debounceSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(async () => {
      try {
        await this.config.onSave(this.currentCredentials);
        const statusEl = this.contentEl.querySelector('.app-config-status');
        if (statusEl) {
          statusEl.setText('Saved');
          statusEl.className = 'app-config-status app-config-status-saved';
          setTimeout(() => {
            if (statusEl) {
              statusEl.setText('Ready');
              statusEl.className = 'app-config-status';
            }
          }, 2000);
        }
      } catch (error) {
        // Save failed silently
      }
    }, 500);
  }

  onClose(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.contentEl.empty();
  }
}
