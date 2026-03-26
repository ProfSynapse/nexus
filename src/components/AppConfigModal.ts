/**
 * AppConfigModal — Modal for configuring app credentials and settings.
 *
 * Renders input fields from the app's manifest.credentials declaration,
 * and optional settings sections (e.g., model selection dropdowns)
 * provided via the settingsSections config.
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import { AppManifest } from '../types/apps/AppTypes';

/**
 * An option in a settings dropdown.
 */
export interface AppSettingOption {
  value: string;
  label: string;
}

/**
 * Declares a settings section to render after credentials.
 * Currently supports 'dropdown' type for model selection.
 */
export interface AppSettingsSection {
  /** Settings key (e.g., 'defaultTTSModel') */
  key: string;
  /** Display label */
  label: string;
  /** Help text */
  description: string;
  /** Async loader for dropdown options */
  loadOptions: () => Promise<{ success: boolean; options?: AppSettingOption[]; error?: string }>;
}

export interface AppConfigModalConfig {
  manifest: AppManifest;
  credentials: Record<string, string>;
  settings?: Record<string, string>;
  onSave: (credentials: Record<string, string>) => Promise<void>;
  onSaveSettings?: (settings: Record<string, string>) => Promise<void>;
  onUninstall?: () => Promise<void>;
  onValidate?: () => Promise<{ success: boolean; error?: string; data?: unknown }>;
  settingsSections?: AppSettingsSection[];
}

export class AppConfigModal extends Modal {
  private config: AppConfigModalConfig;
  private currentCredentials: Record<string, string>;
  private currentSettings: Record<string, string>;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, config: AppConfigModalConfig) {
    super(app);
    this.config = config;
    this.currentCredentials = { ...config.credentials };
    this.currentSettings = { ...(config.settings || {}) };
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

    // Settings sections (e.g., model dropdown)
    if (this.config.settingsSections && this.config.settingsSections.length > 0) {
      contentEl.createDiv('app-config-settings-divider');
      contentEl.createEl('h3', { text: 'Settings', cls: 'app-config-settings-heading' });

      for (const section of this.config.settingsSections) {
        this.renderSettingsSection(contentEl, section);
      }
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

  /**
   * Render a settings section with an async-loaded dropdown.
   */
  private renderSettingsSection(container: HTMLElement, section: AppSettingsSection): void {
    const setting = new Setting(container)
      .setName(section.label)
      .setDesc(section.description);

    // Add dropdown with loading state
    setting.addDropdown(dropdown => {
      dropdown.addOption('', 'Loading...');
      dropdown.setDisabled(true);

      // Load options asynchronously
      section.loadOptions().then(result => {
        // Clear loading option
        dropdown.selectEl.empty();

        if (!result.success || !result.options || result.options.length === 0) {
          dropdown.addOption('', result.error || 'No models available');
          dropdown.setDisabled(true);
          return;
        }

        // Add a "use default" option
        dropdown.addOption('', 'Use default model');

        for (const option of result.options) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(this.currentSettings[section.key] || '');
        dropdown.setDisabled(false);

        dropdown.onChange((value) => {
          this.currentSettings[section.key] = value;
          this.debounceSaveSettings();
        });
      });
    });
  }

  private debounceSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(async () => {
      try {
        await this.config.onSave(this.currentCredentials);
        this.updateStatusEl('Saved');
      } catch {
        // Save failed silently
      }
    }, 500);
  }

  private debounceSaveSettings(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(async () => {
      try {
        if (this.config.onSaveSettings) {
          await this.config.onSaveSettings(this.currentSettings);
        }
        this.updateStatusEl('Saved');
      } catch {
        // Save failed silently
      }
    }, 500);
  }

  private updateStatusEl(text: string): void {
    const statusEl = this.contentEl.querySelector('.app-config-status');
    if (statusEl) {
      statusEl.setText(text);
      statusEl.className = 'app-config-status app-config-status-saved';
      setTimeout(() => {
        if (statusEl) {
          statusEl.setText('Ready');
          statusEl.className = 'app-config-status';
        }
      }, 2000);
    }
  }

  onClose(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.contentEl.empty();
  }
}
