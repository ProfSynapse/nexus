/**
 * BackButton - Consistent back navigation component for detail views
 * Uses Obsidian-native styling patterns
 */

import { Component } from 'obsidian';

export class BackButton {
    private element: HTMLElement;

    /**
     * Create a back button
     * @param container Parent element to attach to
     * @param label Text to display (e.g., "Back to Workspaces")
     * @param onClick Callback when clicked
     * @param component Optional Component for registerDomEvent
     */
    constructor(container: HTMLElement, label: string, onClick: () => void, component?: Component) {
        this.element = container.createDiv('nexus-back-button');

        // SVG arrow icon
        const iconSpan = this.element.createSpan({ cls: 'nexus-back-button-icon' });
        iconSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;

        // Label text
        this.element.createSpan({ text: label });

        // Click handler
        component!.registerDomEvent(this.element, 'click', onClick);
    }

    /**
     * Get the underlying element
     */
    getElement(): HTMLElement {
        return this.element;
    }

    /**
     * Remove the button from DOM
     */
    destroy(): void {
        this.element.remove();
    }
}
