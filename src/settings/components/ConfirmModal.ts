/**
 * ConfirmModal — Variant-aware confirmation modal.
 *
 * Replaces ad-hoc inline modals (e.g., WorkspaceDetailRenderer.confirmDangerousAction)
 * with a single primitive whose copy + CTA scales by variant.
 *
 * Pure DOM + Obsidian Modal — no Node.js imports. Mobile-compatible.
 */

import { App, ButtonComponent, Modal, Notice } from 'obsidian';

export type ConfirmVariant = 'delete' | 'remove' | 'archive';

export interface ConfirmModalConfig {
    variant: ConfirmVariant;
    title: string;
    body: string;
    /** Optional CTA label override. Defaults from variant. */
    ctaLabel?: string;
    /**
     * Optional side-effect callback invoked on CTA click. May return a Promise.
     * The boolean Promise returned by `ConfirmModal.confirm()` reflects which
     * button was clicked (Cancel=false / CTA=true), NOT this callback's return.
     * If onConfirm rejects or throws, the failure is surfaced via Notice +
     * console.error and the confirm-Promise resolves false.
     */
    onConfirm?: () => void | Promise<void>;
    /**
     * Internal resolver wired by `ConfirmModal.confirm()`. Receives the final
     * confirmed boolean exactly once on modal close.
     */
    onResolve?: (confirmed: boolean) => void;
}

const DEFAULT_CTA: Record<ConfirmVariant, string> = {
    delete: 'Delete',
    remove: 'Remove',
    archive: 'Archive'
};

export class ConfirmModal extends Modal {
    private readonly config: ConfirmModalConfig;
    private confirmed = false;

    constructor(app: App, config: ConfirmModalConfig) {
        super(app);
        this.config = config;
    }

    /**
     * Open a ConfirmModal and resolve with the user's choice.
     * Cancel / dismiss -> false. CTA -> true (or false if onConfirm threw/rejected).
     * The modal closes regardless of onConfirm outcome.
     */
    static confirm(app: App, config: ConfirmModalConfig): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const modal = new ConfirmModal(app, {
                ...config,
                onResolve: resolve
            });
            modal.open();
        });
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
            void Promise.resolve(this.config.onConfirm?.())
                .then(() => { this.confirmed = true; })
                .catch((err) => this.handleConfirmError(err))
                .finally(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
        this.config.onResolve?.(this.confirmed);
    }

    private handleConfirmError(err: unknown): void {
        console.error('ConfirmModal onConfirm threw:', err);
        new Notice('Action failed');
        this.confirmed = false;
    }
}
