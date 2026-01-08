/**
 * BackButton - Consistent back navigation component for detail views
 * Uses Obsidian-native styling patterns
 */

import { Component, setIcon } from 'obsidian';

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

        const iconSpan = this.element.createSpan({ cls: 'nexus-back-button-icon' });
        setIcon(iconSpan, 'chevron-left');

        // Label text
        this.element.createSpan({ text: label });

        // Click handler - use component.registerDomEvent if available, otherwise addEventListener
        if (component) {
            component.registerDomEvent(this.element, 'click', onClick);
        } else {
            this.element.addEventListener('click', onClick);
        }
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
