/**
 * ServerConfiguration - Handles server configuration and identification
 * Follows Single Responsibility Principle by focusing only on configuration
 */

import { App } from 'obsidian';
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { logger } from '../../utils/logger';
import { desktopRequire } from '../../utils/desktopRequire';
import { getPrimaryServerKey, getPrimaryIpcPath, getPrimaryVaultNotePath } from '../../constants/branding';

export interface ServerConfigurationOptions {
    serverName?: string;
    vaultName?: string;
    capabilities?: ServerCapabilities;
}

export interface ServerCapabilities {
    resources: {
        supportsUriTemplates: boolean;
        supportsContentWatch: boolean;
        supportsListWatch: boolean;
    };
    tools: {
        supportsToolDescriptionMarkdown: boolean;
        supportsToolArgumentsMarkdown: boolean;
    };
    prompts: Record<string, never>;
}

/**
 * Service responsible for server configuration management
 * Follows SRP by focusing only on configuration operations
 */
export class ServerConfiguration {
    private serverName?: string;
    private vaultName: string;
    private sanitizedVaultName: string;
    private capabilities: ServerCapabilities;

    constructor(
        private app: App,
        options: ServerConfigurationOptions = {}
    ) {
        this.serverName = options.serverName;
        this.vaultName = options.vaultName || this.getVaultName();
        this.sanitizedVaultName = sanitizeVaultName(this.vaultName);
        this.capabilities = options.capabilities || this.getDefaultCapabilities();
    }

    /**
     * Get the vault name from the app
     */
    private getVaultName(): string {
        try {
            return this.app.vault.getName();
        } catch (error) {
            logger.systemError(error as Error, 'Vault Name Retrieval');
            return 'default';
        }
    }

    /**
     * Get default server capabilities
     */
    private getDefaultCapabilities(): ServerCapabilities {
        return {
            resources: {
                supportsUriTemplates: true,
                supportsContentWatch: false,
                supportsListWatch: false
            },
            tools: {
                supportsToolDescriptionMarkdown: true,
                supportsToolArgumentsMarkdown: true
            },
            prompts: {}
        };
    }

    /**
     * Get the server identifier
     */
    getServerIdentifier(): string {
        if (this.serverName) {
            return this.serverName;
        }
        
        return getPrimaryServerKey(this.vaultName);
    }

    /**
     * Get the server info for SDK initialization
     */
    getServerInfo(): { name: string; version: string } {
        return {
            name: this.getServerIdentifier(),
            version: "1.0.0"
        };
    }

    /**
     * Get server options for SDK initialization
     */
    getServerOptions(): { capabilities: ServerCapabilities } {
        return {
            capabilities: this.capabilities
        };
    }

    /**
     * Get the IPC path for this server
     */
    getIPCPath(): string {
        return getPrimaryIpcPath(this.vaultName, this.isWindows());
    }

    /**
     * Where this server publishes `{ vaultName, basePath }` for the CLI so a
     * `nexus` run from inside the vault folder can pick this vault without
     * `--vault`. Beside the socket on Unix; under %TEMP% on Windows, where the
     * pipe namespace holds no files.
     */
    getVaultNotePath(): string {
        const isWindows = this.isWindows();
        const tempDir = isWindows ? desktopRequire<typeof import('os')>('os').tmpdir() : '';
        return getPrimaryVaultNotePath(this.vaultName, isWindows, tempDir);
    }

    /**
     * The vault's absolute folder on disk, or null when the adapter cannot say
     * (mobile, or a non-filesystem adapter). Callers must treat null as "do not
     * publish" rather than guess.
     */
    getVaultBasePath(): string | null {
        try {
            const adapter = this.app.vault.adapter as { getBasePath?: () => string };
            if (typeof adapter.getBasePath !== 'function') {
                return null;
            }
            const basePath = adapter.getBasePath();
            return typeof basePath === 'string' && basePath.length > 0 ? basePath : null;
        } catch {
            return null;
        }
    }

    /**
     * Get the vault name
     */
    getVaultNameValue(): string {
        return this.vaultName;
    }

    /**
     * Get the sanitized vault name
     */
    getSanitizedVaultName(): string {
        return this.sanitizedVaultName;
    }

    /**
     * Get the server capabilities
     */
    getCapabilities(): ServerCapabilities {
        return this.capabilities;
    }

    /**
     * Update server capabilities
     */
    updateCapabilities(capabilities: Partial<ServerCapabilities>): void {
        this.capabilities = { ...this.capabilities, ...capabilities };
    }

    /**
     * Check if this is a Windows platform
     */
    isWindows(): boolean {
        return process.platform === 'win32';
    }

    /**
     * Get configuration summary
     */
    getConfigurationSummary(): {
        serverIdentifier: string;
        vaultName: string;
        sanitizedVaultName: string;
        ipcPath: string;
        isWindows: boolean;
        hasCustomName: boolean;
    } {
        return {
            serverIdentifier: this.getServerIdentifier(),
            vaultName: this.vaultName,
            sanitizedVaultName: this.sanitizedVaultName,
            ipcPath: this.getIPCPath(),
            isWindows: this.isWindows(),
            hasCustomName: !!this.serverName
        };
    }
}
