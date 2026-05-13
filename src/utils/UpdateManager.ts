import { Plugin, requestUrl } from 'obsidian';

export interface GitHubRelease {
    tag_name: string;
    html_url?: string;
}

/**
 * UpdateManager handles read-only release checks.
 *
 * Community plugin installs must be updated through Obsidian's plugin updater.
 * This class intentionally does not download or overwrite plugin assets at
 * runtime.
 */
export class UpdateManager {
    private static _isStoreAvailable: boolean | null = null;

    /**
     * Check if this plugin is listed in the Obsidian community plugin registry.
     * Result is cached for the session lifetime.
     * @param pluginId The plugin manifest id to look up
     * @returns true if the plugin is in the store, false otherwise
     */
    static async isStoreAvailable(pluginId: string): Promise<boolean> {
        if (UpdateManager._isStoreAvailable !== null) {
            return UpdateManager._isStoreAvailable;
        }
        try {
            const response = await requestUrl({
                url: 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json',
                method: 'GET',
            });
            if (response.status === 200) {
                const plugins: Array<{ id: string }> = response.json as Array<{ id: string }>;
                UpdateManager._isStoreAvailable = plugins.some(p => p.id === pluginId);
                return UpdateManager._isStoreAvailable;
            }
        } catch {
            // Network error — assume not in store (show updater)
        }
        UpdateManager._isStoreAvailable = false;
        return false;
    }

    private readonly GITHUB_API_ENDPOINTS = [
        'https://api.github.com/repos/ProfSynapse/nexus',
        'https://api.github.com/repos/ProfSynapse/claudesidian-mcp'
    ];

    constructor(private plugin: Plugin) {}

    /**
     * Check if a new version is available
     * @returns true if update available, false if current
     */
    async checkForUpdate(): Promise<boolean> {
        try {
            const release = await this.fetchLatestRelease();
            const latestVersion = release.tag_name.replace('v', '');
            const currentVersion = this.plugin.manifest.version;

            return this.compareVersions(latestVersion, currentVersion) > 0;
        } catch (error) {
            console.error('Failed to check for updates:', error);
            throw new Error('Failed to check for updates: ' + (error as Error).message);
        }
    }

    /**
     * Get the latest available version
     * @returns version string without 'v' prefix
     */
    async getLatestVersion(): Promise<string> {
        const release = await this.fetchLatestRelease();
        return release.tag_name.replace('v', '');
    }

    /**
     * Get the latest release page URL for manual installs.
     */
    async getLatestReleaseUrl(): Promise<string> {
        const release = await this.fetchLatestRelease();
        return release.html_url ?? 'https://github.com/ProfSynapse/claudesidian-mcp/releases/latest';
    }

    /**
     * Compare two version strings
     * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
     */
    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);

        for (let i = 0; i < 3; i++) {
            if (parts1[i] > parts2[i]) return 1;
            if (parts1[i] < parts2[i]) return -1;
        }
        
        return 0;
    }

    /**
     * Fetch latest release information from GitHub
     */
    async fetchLatestRelease(): Promise<GitHubRelease> {
        const errors: Error[] = [];

        for (const endpoint of this.GITHUB_API_ENDPOINTS) {
            try {
                const response = await requestUrl({
                    url: `${endpoint}/releases/latest`,
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Obsidian-Plugin-Updater'
                    }
                });

                if (response.status === 200) {
                    return response.json as GitHubRelease;
                }

                errors.push(new Error(`GitHub API error: ${response.status} (${endpoint})`));
            } catch (error) {
                const err = error as Error;
                errors.push(err);
            }
        }

        const lastError = errors[errors.length - 1];
        throw new Error(`Failed to fetch release info: ${lastError?.message ?? 'Unknown error'}`);
    }
}
