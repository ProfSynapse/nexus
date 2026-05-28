/**
 * BoxedSection — Boxed section primitive with sticky header + scrollable body
 * + optional toolbar + optional accent action button.
 *
 * Visual contract: docs/mockups/workspace-tab-redesign-v3-subpages.html
 * (`.ws-section` family).
 *
 * Pure DOM + Obsidian-safe — no Node.js imports. Mobile-compatible.
 */

import { Component } from 'obsidian';

export interface BoxedSectionConfig {
    /** Section title text. */
    title: string;
    /**
     * Optional explicit id for the title element. When set, the wrapping
     * `<section>` receives `aria-labelledby=<titleId>` for screen readers.
     */
    titleId?: string;
    /**
     * Toolbar render callback. Receives the toolbar host element so callers
     * can append filter/sort/toggle affordances. Mounted in the header right
     * cluster, before the optional action button.
     */
    toolbar?: (toolbar: HTMLElement) => void;
    /** Accent action button label (e.g., "+ New project"). */
    actionLabel?: string;
    /** Click handler for the accent action button. Ignored unless actionLabel is set. */
    onAction?: () => void;
    /** Body render callback. Receives the scrollable body element. */
    body: (body: HTMLElement) => void;
    /**
     * When true, body has `max-height: none` (no internal scroll — content
     * flows naturally). Use for form-field sections + lists that own their
     * own scroll context.
     */
    unbounded?: boolean;
}

export class BoxedSection {
    private readonly sectionEl: HTMLElement;
    private readonly bodyEl: HTMLElement;

    constructor(container: HTMLElement, config: BoxedSectionConfig, component: Component) {
        this.sectionEl = container.createEl('section', { cls: 'ws-section' });
        if (config.titleId) {
            this.sectionEl.setAttribute('aria-labelledby', config.titleId);
        }

        const header = this.sectionEl.createDiv('ws-section-header');
        const titleEl = header.createEl('h3', {
            text: config.title,
            cls: 'ws-section-title'
        });
        if (config.titleId) {
            titleEl.id = config.titleId;
        }

        const hasToolbar = !!config.toolbar;
        const hasAction = !!config.actionLabel && !!config.onAction;
        if (hasToolbar || hasAction) {
            const toolbar = header.createDiv('ws-section-toolbar');
            if (config.toolbar) {
                config.toolbar(toolbar);
            }
            if (hasAction) {
                const button = toolbar.createEl('button', {
                    text: config.actionLabel,
                    cls: 'ws-section-action',
                    attr: { type: 'button' }
                });
                const handler = () => { config.onAction?.(); };
                component.registerDomEvent(button, 'click', handler);
            }
        }

        this.bodyEl = this.sectionEl.createDiv('ws-section-body');
        if (config.unbounded) {
            this.bodyEl.addClass('is-unbounded');
        }

        config.body(this.bodyEl);
    }

    /**
     * Returns the scrollable body element for late re-renders.
     * Callers should `body.empty()` before re-rendering content.
     */
    getBody(): HTMLElement {
        return this.bodyEl;
    }

    /** Returns the outer `<section>` element. */
    getElement(): HTMLElement {
        return this.sectionEl;
    }
}
