import { Plugin } from 'obsidian';
import { CONNECTOR_JS_CONTENT } from './connectorContent';

/**
 * Ensures connector.js exists in the plugin folder.
 *
 * The connector.js file is required for Claude Desktop and other MCP clients
 * to communicate with the Obsidian plugin. If it's missing (e.g., due to
 * incomplete installation or accidental deletion), this utility will
 * automatically recreate it from the embedded content.
 */
export class ConnectorEnsurer {
    constructor(private plugin: Plugin) {}

    /**
     * Check if connector.js exists, and create it if missing.
     * @returns true if connector.js exists (or was created), false on error
     */
    async ensureConnectorExists(): Promise<boolean> {
        const pluginDir = this.plugin.manifest.dir;
        if (!pluginDir) {
            console.error('[ConnectorEnsurer] Plugin directory not available');
            return false;
        }

        const connectorPath = `${pluginDir}/connector.js`;

        try {
            // Use Obsidian's adapter.exists() method
            const exists = await this.plugin.app.vault.adapter.exists(connectorPath);

            if (exists) {
                console.log('[ConnectorEnsurer] connector.js exists');
                return true;
            }

            // File doesn't exist - write it out
            console.log('[ConnectorEnsurer] connector.js missing, creating...');
            await this.plugin.app.vault.adapter.write(connectorPath, CONNECTOR_JS_CONTENT);
            console.log('[ConnectorEnsurer] connector.js created successfully');
            return true;

        } catch (error) {
            console.error('[ConnectorEnsurer] Failed to ensure connector.js:', error);
            return false;
        }
    }

    /**
     * Force recreate connector.js even if it exists.
     * Useful for updates or repairs.
     * @returns true if successful, false on error
     */
    async recreateConnector(): Promise<boolean> {
        const pluginDir = this.plugin.manifest.dir;
        if (!pluginDir) {
            console.error('[ConnectorEnsurer] Plugin directory not available');
            return false;
        }

        const connectorPath = `${pluginDir}/connector.js`;

        try {
            console.log('[ConnectorEnsurer] Recreating connector.js...');
            await this.plugin.app.vault.adapter.write(connectorPath, CONNECTOR_JS_CONTENT);
            console.log('[ConnectorEnsurer] connector.js recreated successfully');
            return true;
        } catch (error) {
            console.error('[ConnectorEnsurer] Failed to recreate connector.js:', error);
            return false;
        }
    }
}
