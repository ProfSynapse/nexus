/**
 * ConfirmModal — Variant-aware confirmation modal.
 *
 * Replaces ad-hoc inline modals (e.g., WorkspaceDetailRenderer.confirmDangerousAction)
 * with a single primitive whose copy + CTA scales by variant.
 *
 * Pure DOM + Obsidian Modal — no Node.js imports. Mobile-compatible.
 */

import { App, ButtonComponent, Modal } from 'obsidian';

export type ConfirmVariant = 'delete' | 'remove' | 'archive';

export interface ConfirmModalConfig {
    variant: ConfirmVariant;
    title: string;
    body: string;
    /** Optional CTA label override. Defaults from variant. */
    ctaLabel?: string;
    /** Invoked when user confirms. May return a Promise; modal closes after resolve. */
    onConfirm: () => void | Promise<void>;
}

const DEFAULT_CTA: Record<ConfirmVariant, string> = {
    delete: 'Delete',
    remove: 'Remove',
    archive: 'Archive'
};

export class ConfirmModal extends Modal {
    private readonly config: ConfirmModalConfig;

    constructor(app: App, config: ConfirmModalConfig) {
        super(app);
        this.config = config;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('nexus-confirm-modal');
        contentEl.addClass(`nexus-confirm-modal--${this.config.variant}`);

        contentEl.createEl('h2', { text: this.config.title });
        contentEl.createEl('p', { text: this.config.body });

        const buttons = contentEl.createDiv('modal-button-container');

        new ButtonComponent(buttons)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        const ctaLabel = this.config.ctaLabel ?? DEFAULT_CTA[this.config.variant];
        const cta = new ButtonComponent(buttons).setButtonText(ctaLabel);

        // Destructive variants get the warning styling; archive is reversible.
        if (this.config.variant === 'delete' || this.config.variant === 'remove') {
            cta.setWarning();
        } else {
            cta.setCta();
        }

        cta.onClick(() => {
            void Promise.resolve(this.config.onConfirm()).finally(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
