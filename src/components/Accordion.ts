import { Component, setIcon } from 'obsidian';

/**
 * Options for a shared settings accordion ("fold").
 */
export interface AccordionOptions {
    /** Stable fold id; also the basis of the content element's DOM id. */
    id: string;
    title: string;
    /** Lucide icon name shown before the title. */
    icon?: string;
    /** One-line summary shown under the title while the fold is closed. */
    summary?: string;
    /** Open on creation. Defaults to closed. */
    open?: boolean;
    /** Called once per user toggle (and for non-silent setOpen calls that change state). */
    onToggle?: (open: boolean) => void;
}

let accordionSequence = 0;

/**
 * The one collapsible used across Nexus settings.
 *
 * Markup:
 *   div.nexus-accordion[.is-open]
 *     button.nexus-accordion-toggle[aria-expanded][aria-controls]
 *       span.nexus-accordion-icon
 *       span.nexus-accordion-text > span.nexus-accordion-title + span.nexus-accordion-summary
 *       span.nexus-accordion-chevron
 *     div.nexus-accordion-content.setting-group[id][hidden]
 *       div.setting-items   (exposed as itemsEl; the same node for the accordion's lifetime)
 *
 * The content reuses Obsidian's setting-group markup so rows added with
 * `new Setting(accordion.itemsEl)` get the core 1.11+ group styling. The toggle
 * is a native button, so Enter and Space work without extra key handling.
 */
export class Accordion extends Component {
    readonly containerEl: HTMLElement;
    readonly rootEl: HTMLElement;
    readonly toggleEl: HTMLButtonElement;
    readonly titleEl: HTMLElement;
    readonly summaryEl: HTMLElement;
    readonly chevronEl: HTMLElement;
    readonly contentEl: HTMLElement;
    readonly itemsEl: HTMLElement;
    private open: boolean;
    private summary: string;
    private readonly onToggle?: (open: boolean) => void;

    constructor(containerEl: HTMLElement, options: AccordionOptions) {
        super();
        this.containerEl = containerEl;
        this.open = options.open === true;
        this.summary = options.summary ?? '';
        this.onToggle = options.onToggle;

        const contentId = `nexus-accordion-${options.id}-${++accordionSequence}`;

        this.rootEl = containerEl.createDiv({ cls: 'nexus-accordion' });
        this.rootEl.setAttribute('data-fold', options.id);

        this.toggleEl = this.rootEl.createEl('button', {
            cls: 'nexus-accordion-toggle',
            attr: { type: 'button', 'aria-controls': contentId }
        });

        if (options.icon) {
            const iconEl = this.toggleEl.createSpan({ cls: 'nexus-accordion-icon' });
            setIcon(iconEl, options.icon);
        }

        const textEl = this.toggleEl.createSpan({ cls: 'nexus-accordion-text' });
        this.titleEl = textEl.createSpan({ cls: 'nexus-accordion-title', text: options.title });
        this.summaryEl = textEl.createSpan({ cls: 'nexus-accordion-summary' });
        this.chevronEl = this.toggleEl.createSpan({ cls: 'nexus-accordion-chevron' });

        this.contentEl = this.rootEl.createDiv({ cls: ['nexus-accordion-content', 'setting-group'] });
        this.contentEl.id = contentId;
        this.itemsEl = this.contentEl.createDiv({ cls: 'setting-items' });

        this.registerDomEvent(this.toggleEl, 'click', () => this.toggle());
        this.applyState();
    }

    get isOpen(): boolean {
        return this.open;
    }

    /** Replace the collapsed summary line. Hidden while the fold is open. */
    setSummary(summary: string): this {
        this.summary = summary;
        this.summaryEl.setText(summary);
        this.summaryEl.hidden = this.open || summary.length === 0;
        return this;
    }

    /**
     * Open or close the fold. `silent` updates the DOM without calling onToggle,
     * for restoring remembered state.
     */
    setOpen(open: boolean, options: { silent?: boolean } = {}): this {
        if (open === this.open) return this;
        this.open = open;
        this.applyState();
        if (!options.silent) this.onToggle?.(open);
        return this;
    }

    toggle(): void {
        this.setOpen(!this.open);
    }

    private applyState(): void {
        this.rootEl.toggleClass('is-open', this.open);
        this.toggleEl.setAttribute('aria-expanded', String(this.open));
        this.contentEl.hidden = !this.open;
        this.chevronEl.empty();
        setIcon(this.chevronEl, this.open ? 'chevron-up' : 'chevron-down');
        this.setSummary(this.summary);
    }
}
