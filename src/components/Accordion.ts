import { Component } from 'obsidian';

/**
 * A collapsible accordion component for Obsidian plugin settings
 * Provides smooth animations and mobile-friendly interaction
 */
export class Accordion extends Component {
    containerEl: HTMLElement;
    rootEl: HTMLElement;
    contentEl: HTMLElement;
    isOpen: boolean;

    /**
     * Create a new accordion
     * @param containerEl Parent container element
     * @param title Accordion header title
     * @param defaultOpen Whether accordion is open by default
     */
    constructor(containerEl: HTMLElement, title: string, defaultOpen = false) {
        super();
        
        this.containerEl = containerEl;
        this.isOpen = defaultOpen;
        
        // Create main accordion container
        const accordionEl = this.containerEl.createEl('div', {
            cls: 'mcp-accordion'
        });
        this.rootEl = accordionEl;

        // Create container to scope selectors
        const accordionContainer = accordionEl.createEl('div', {
            cls: 'mcp-accordion-container'
        });

        // Create header with toggle button
        const headerEl = accordionContainer.createEl('div', {
            cls: 'mcp-accordion-header'
        });

        const toggleButton = headerEl.createEl('button', {
            cls: 'mcp-accordion-toggle'
        });

        // Add title
        toggleButton.createEl('span', {
            text: title,
            cls: 'mcp-accordion-title'
        });

        // Add expand/collapse icon
        toggleButton.createEl('span', {
            cls: `mcp-accordion-icon ${this.isOpen ? 'is-open' : ''}`
        });

        // Create content container
        this.contentEl = accordionContainer.createEl('div', {
            cls: `mcp-accordion-content ${this.isOpen ? 'is-open' : ''}`
        });

        // Toggle on click - using registerDomEvent for auto-cleanup
        this.registerDomEvent(toggleButton, 'click', () => {
            this.toggle(accordionContainer);
        });
    }

    /**
     * Toggle accordion open/closed state
     * @param container The accordion container element to toggle
     */
    toggle(container: HTMLElement): void {
        this.isOpen = !this.isOpen;
        
        // Update icon - scoped to this container
        const iconEl = container.querySelector('.mcp-accordion-icon');
        if (iconEl) {
            iconEl.classList.toggle('is-open');
        }
        
        // Update content - scoped to this container
        const contentEl = container.querySelector('.mcp-accordion-content');
        if (contentEl) {
            contentEl.classList.toggle('is-open');
        }
    }

    /**
     * Get the content element to add children to
     */
    getContentEl(): HTMLElement {
        const innerContent = this.contentEl.createEl('div');
        return innerContent;
    }
}
