/**
 * OAuthModals
 *
 * Helper modals for the OAuth connect flow:
 * - OAuthConsentModal: experimental provider warning + optional pre-auth fields
 * - OAuthPreAuthModal: pre-auth field collection for non-experimental providers
 */

import { Modal, App, Setting } from 'obsidian';
import type { OAuthModalConfig } from '../types';

/**
 * Modal shown before an experimental OAuth flow starts.
 * Displays a warning and optionally collects pre-auth fields.
 */
export class OAuthConsentModal extends Modal {
  private oauthConfig: OAuthModalConfig;
  private onConfirm: (params: Record<string, string>) => void;
  private onCancel: () => void;

  constructor(
    app: App,
    oauthConfig: OAuthModalConfig,
    onConfirm: (params: Record<string, string>) => void,
    onCancel: () => void,
  ) {
    super(app);
    this.oauthConfig = oauthConfig;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('oauth-consent-modal');

    contentEl.createEl('h2', { text: 'Experimental feature' });

    if (this.oauthConfig.experimentalWarning) {
      contentEl.createEl('p', {
        text: this.oauthConfig.experimentalWarning,
        cls: 'oauth-consent-warning',
      });
    }

    const fieldValues: Record<string, string> = {};
    if (this.oauthConfig.preAuthFields && this.oauthConfig.preAuthFields.length > 0) {
      this.renderFields(contentEl, fieldValues);
    }

    const buttonContainer = contentEl.createDiv('oauth-consent-buttons');

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.onCancel();
      this.close();
    });

    const confirmBtn = buttonContainer.createEl('button', {
      text: 'I understand, connect',
      cls: 'mod-cta',
    });
    confirmBtn.addEventListener('click', () => {
      this.onConfirm(fieldValues);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderFields(
    container: HTMLElement,
    fieldValues: Record<string, string>,
  ): void {
    const fieldsContainer = container.createDiv('oauth-consent-fields');
    for (const field of this.oauthConfig.preAuthFields!) {
      fieldValues[field.key] = field.defaultValue || '';
      new Setting(fieldsContainer)
        .setName(field.label)
        .addText(text => {
          text
            .setPlaceholder(field.placeholder || '')
            .setValue(field.defaultValue || '')
            .onChange(value => { fieldValues[field.key] = value; });
        });
    }
  }
}

/**
 * Modal for collecting pre-auth fields when there is no experimental warning.
 */
export class OAuthPreAuthModal extends Modal {
  private oauthConfig: OAuthModalConfig;
  private onConfirm: (params: Record<string, string>) => void;
  private onCancel: () => void;

  constructor(
    app: App,
    oauthConfig: OAuthModalConfig,
    onConfirm: (params: Record<string, string>) => void,
    onCancel: () => void,
  ) {
    super(app);
    this.oauthConfig = oauthConfig;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('oauth-preauth-modal');

    contentEl.createEl('h2', {
      text: `Connect with ${this.oauthConfig.providerLabel}`,
    });

    const fieldValues: Record<string, string> = {};
    const fieldsContainer = contentEl.createDiv('oauth-preauth-fields');

    for (const field of this.oauthConfig.preAuthFields || []) {
      fieldValues[field.key] = field.defaultValue || '';
      new Setting(fieldsContainer)
        .setName(field.label)
        .addText(text => {
          text
            .setPlaceholder(field.placeholder || '')
            .setValue(field.defaultValue || '')
            .onChange(value => { fieldValues[field.key] = value; });
        });
    }

    const buttonContainer = contentEl.createDiv('oauth-preauth-buttons');

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.onCancel();
      this.close();
    });

    const confirmBtn = buttonContainer.createEl('button', {
      text: 'Connect',
      cls: 'mod-cta',
    });
    confirmBtn.addEventListener('click', () => {
      this.onConfirm(fieldValues);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
