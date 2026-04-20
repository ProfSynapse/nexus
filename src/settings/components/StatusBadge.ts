/**
 * StatusBadge - Shows configured/not configured status indicator
 * Uses Obsidian-native styling with CSS classes
 */

export class StatusBadge {
    /**
     * Render a status badge
     * @param container Parent element to attach to
     * @param configured Whether the item is configured
     * @returns The created badge element
     */
    static render(container: HTMLElement, configured: boolean): HTMLElement {
        const badge = container.createSpan('nexus-status-badge');
        badge.addClass(configured ? 'configured' : 'not-configured');
        badge.setText(configured ? '✓' : '○');
        return badge;
    }

    /**
     * Render a status badge with custom text
     * @param container Parent element to attach to
     * @param configured Whether the item is configured
     * @param configuredText Text to show when configured
     * @param notConfiguredText Text to show when not configured
     */
    static renderWithText(
        container: HTMLElement,
        configured: boolean,
        configuredText = 'Configured',
        notConfiguredText = 'Not configured'
    ): HTMLElement {
        const badge = container.createSpan('nexus-status-badge');
        badge.addClass(configured ? 'configured' : 'not-configured');
        badge.setText(configured ? configuredText : notConfiguredText);
        return badge;
    }

    /**
     * Update an existing badge's status
     * @param badge The badge element to update
     * @param configured New configuration status
     */
    static update(badge: HTMLElement, configured: boolean): void {
        badge.removeClass('configured', 'not-configured');
        badge.addClass(configured ? 'configured' : 'not-configured');
        badge.setText(configured ? '✓' : '○');
    }
}
