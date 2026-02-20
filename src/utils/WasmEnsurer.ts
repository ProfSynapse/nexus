import { Plugin, Notice, requestUrl } from 'obsidian';

/**
 * Location: src/utils/WasmEnsurer.ts
 *
 * Ensures sqlite3.wasm exists in the plugin folder.
 *
 * The sqlite3.wasm file is required for SQLite caching functionality.
 * If it's missing (e.g., due to incomplete installation or manual install
 * that only copied main.js/manifest.json), this utility will automatically
 * download it from the npm CDN.
 *
 * Download sources (in order of preference):
 * 1. jsDelivr CDN - fast, reliable
 * 2. unpkg CDN - fallback
 */
export class WasmEnsurer {
    // CDN URLs for the WASM file from @dao-xyz/sqlite3-vec package
    // Version should match package.json dependency
    private static readonly WASM_URLS = [
        'https://cdn.jsdelivr.net/npm/@dao-xyz/sqlite3-vec@0.0.19/sqlite-wasm/jswasm/sqlite3.wasm',
        'https://unpkg.com/@dao-xyz/sqlite3-vec@0.0.19/sqlite-wasm/jswasm/sqlite3.wasm'
    ];

    private static readonly WASM_FILENAME = 'sqlite3.wasm';
    // Expected size ~3.4MB, reject if too small (likely error page)
    private static readonly MIN_WASM_SIZE = 1_000_000;

    constructor(private plugin: Plugin) {}

    /**
     * Check if sqlite3.wasm exists, and download it if missing.
     * Shows a notice during download to inform the user.
     * @returns true if wasm exists (or was downloaded), false on error
     */
    async ensureWasmExists(): Promise<boolean> {
        const pluginDir = this.plugin.manifest.dir;
        if (!pluginDir) {
            console.error('[WasmEnsurer] Plugin directory not available');
            return false;
        }

        const wasmPath = `${pluginDir}/${WasmEnsurer.WASM_FILENAME}`;

        try {
            // Check if file exists
            const exists = await this.plugin.app.vault.adapter.exists(wasmPath);

            if (exists) {
                // Verify it's not corrupted (check file size)
                const stat = await this.plugin.app.vault.adapter.stat(wasmPath);
                if (stat && stat.size >= WasmEnsurer.MIN_WASM_SIZE) {
                    return true;
                }
                console.error('[WasmEnsurer] sqlite3.wasm exists but is too small, re-downloading...');
            }

            // File doesn't exist or is corrupted - download it
            return await this.downloadWasm(wasmPath);

        } catch (error) {
            console.error('[WasmEnsurer] Failed to ensure sqlite3.wasm:', error);
            return false;
        }
    }

    /**
     * Download sqlite3.wasm from CDN
     */
    private async downloadWasm(wasmPath: string): Promise<boolean> {
        const notice = new Notice('Downloading SQLite WASM file... This only happens once.', 0);

        try {
            for (const url of WasmEnsurer.WASM_URLS) {
                try {
                    const response = await requestUrl({
                        url,
                        method: 'GET',
                        // Request binary response
                    });

                    if (response.status !== 200) {
                        console.error(`[WasmEnsurer] HTTP ${response.status} from ${url}`);
                        continue;
                    }

                    const wasmData = response.arrayBuffer;

                    // Validate size
                    if (wasmData.byteLength < WasmEnsurer.MIN_WASM_SIZE) {
                        console.error(`[WasmEnsurer] Downloaded file too small (${wasmData.byteLength} bytes) from ${url}`);
                        continue;
                    }

                    // Write to plugin directory
                    await this.plugin.app.vault.adapter.writeBinary(wasmPath, wasmData);

                    notice.hide();
                    new Notice('SQLite WASM file downloaded successfully!', 3000);
                    return true;

                } catch (error) {
                    console.error(`[WasmEnsurer] Failed to download from ${url}:`, error);
                    // Try next URL
                }
            }

            // All URLs failed
            notice.hide();
            new Notice('Failed to download SQLite WASM file. Please check your internet connection and restart Obsidian.', 10000);
            return false;

        } catch (error) {
            notice.hide();
            console.error('[WasmEnsurer] Download failed:', error);
            new Notice('Failed to download SQLite WASM file. Some features may not work.', 10000);
            return false;
        }
    }

    /**
     * Force re-download sqlite3.wasm even if it exists.
     * Useful for repairs or updates.
     */
    async redownloadWasm(): Promise<boolean> {
        const pluginDir = this.plugin.manifest.dir;
        if (!pluginDir) {
            console.error('[WasmEnsurer] Plugin directory not available');
            return false;
        }

        const wasmPath = `${pluginDir}/${WasmEnsurer.WASM_FILENAME}`;
        return await this.downloadWasm(wasmPath);
    }
}
