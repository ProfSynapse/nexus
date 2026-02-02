import { CustomPrompt, CustomPromptsSettings, DEFAULT_CUSTOM_PROMPTS_SETTINGS } from '../../../types';
import { Settings } from '../../../settings';
import type { MigratableDatabase } from '../../../database/schema/SchemaMigrator';

/**
 * Database-like wrapper that adapts raw sqlite db to MigratableDatabase interface
 * Adds query() method for parameterized SELECT queries
 */
class DatabaseAdapter implements MigratableDatabase {
    constructor(private rawDb: any) {}

    exec(sql: string): { values: any[][] }[] {
        const stmt = this.rawDb.prepare(sql);
        const results: any[][] = [];
        while (stmt.step()) {
            results.push(stmt.get([]));
        }
        stmt.finalize();
        return results.length > 0 ? [{ values: results }] : [];
    }

    run(sql: string, params?: any[]): void {
        const stmt = this.rawDb.prepare(sql);
        if (params?.length) {
            stmt.bind(params);
        }
        stmt.step();
        stmt.finalize();
    }

    /** Query with parameters (extension of MigratableDatabase) */
    query(sql: string, params?: any[]): { values: any[][] }[] {
        const stmt = this.rawDb.prepare(sql);
        if (params?.length) {
            stmt.bind(params);
        }
        const results: any[][] = [];
        while (stmt.step()) {
            results.push(stmt.get([]));
        }
        stmt.finalize();
        return results.length > 0 ? [{ values: results }] : [];
    }
}

/**
 * Service for managing custom prompt storage and persistence
 * Migrated to SQLite-based storage with data.json fallback for backward compatibility
 */
export class CustomPromptStorageService {
    private db: MigratableDatabase | null;
    private settings: Settings;
    private migrated: boolean = false;

    constructor(rawDb: any | null, settings: Settings) {
        // Wrap raw db in adapter if provided
        this.db = rawDb && rawDb.db ? new DatabaseAdapter(rawDb.db) : null;
        this.settings = settings;
        this.initialize();
    }

    /**
     * Initialize the service and migrate data from data.json if needed
     */
    private initialize(): void {
        if (!this.db) {
            // No database available, use data.json only
            return;
        }

        try {
            // Check if table is empty
            const result = this.db.exec('SELECT COUNT(*) as count FROM custom_prompts');
            const count = result.length > 0 && result[0].values.length > 0
                ? result[0].values[0][0] as number
                : 0;

            if (count === 0) {
                // Table empty, migrate from data.json
                this.migrateFromDataJson();
            }

            this.migrated = true;
        } catch (error) {
            console.error('[CustomPromptStorageService] Initialization error:', error);
            // Continue with data.json fallback
        }
    }

    /**
     * Migrate prompts from data.json to SQLite
     */
    private migrateFromDataJson(): void {
        if (!this.db) return;

        const prompts = this.settings.settings.customPrompts?.prompts || [];
        const now = Date.now();

        for (const prompt of prompts) {
            try {
                this.db.run(
                    `INSERT OR REPLACE INTO custom_prompts
                     (id, name, description, prompt, isEnabled, created, modified)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        prompt.id,
                        prompt.name,
                        prompt.description || '',
                        prompt.prompt,
                        prompt.isEnabled ? 1 : 0,
                        now,
                        now
                    ]
                );
            } catch (error) {
                console.error('[CustomPromptStorageService] Error migrating prompt:', prompt.name, error);
            }
        }
    }

    /**
     * Get all custom prompts
     * @returns Array of all custom prompts
     */
    getAllPrompts(): CustomPrompt[] {
        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                const result = this.db.exec('SELECT * FROM custom_prompts ORDER BY name');
                if (result.length > 0 && result[0].values.length > 0) {
                    return result[0].values.map(row => ({
                        id: row[0] as string,
                        name: row[1] as string,
                        description: (row[2] as string) || '',
                        prompt: row[3] as string,
                        isEnabled: (row[4] as number) === 1
                    }));
                }
                return [];
            } catch (error) {
                console.error('[CustomPromptStorageService] Error reading from SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        this.ensureCustomPromptsSettings();
        return this.settings.settings.customPrompts?.prompts || [];
    }

    /**
     * Get enabled custom prompts only
     * @returns Array of enabled custom prompts
     */
    getEnabledPrompts(): CustomPrompt[] {
        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                const result = this.db.exec('SELECT * FROM custom_prompts WHERE isEnabled = 1 ORDER BY name');
                if (result.length > 0 && result[0].values.length > 0) {
                    return result[0].values.map(row => ({
                        id: row[0] as string,
                        name: row[1] as string,
                        description: (row[2] as string) || '',
                        prompt: row[3] as string,
                        isEnabled: true
                    }));
                }
                return [];
            } catch (error) {
                console.error('[CustomPromptStorageService] Error reading from SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        return this.getAllPrompts().filter(prompt => prompt.isEnabled);
    }

    /**
     * Get a specific prompt by name or ID (unified lookup)
     * Tries ID lookup first (more specific), then falls back to name lookup
     * @param identifier Prompt name or ID
     * @returns Custom prompt or undefined if not found
     */
    getPromptByNameOrId(identifier: string): CustomPrompt | undefined {
        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                const adapter = this.db as any;
                const result = adapter.query
                    ? adapter.query('SELECT * FROM custom_prompts WHERE id = ? OR name = ? LIMIT 1', [identifier, identifier])
                    : [];

                if (result.length > 0 && result[0].values.length > 0) {
                    const row = result[0].values[0];
                    return {
                        id: row[0] as string,
                        name: row[1] as string,
                        description: (row[2] as string) || '',
                        prompt: row[3] as string,
                        isEnabled: (row[4] as number) === 1
                    };
                }
                return undefined;
            } catch (error) {
                console.error('[CustomPromptStorageService] Error reading from SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        const prompts = this.getAllPrompts();
        const byId = prompts.find(prompt => prompt.id === identifier);
        if (byId) return byId;
        return prompts.find(prompt => prompt.name === identifier);
    }

    /**
     * Find prompt by name (internal use for duplicate checking)
     */
    private findByName(name: string): CustomPrompt | undefined {
        return this.getPromptByNameOrId(name);
    }

    /**
     * Create a new custom prompt
     * @param promptData Prompt data (without id - will be generated)
     * @returns Created prompt with generated ID
     * @throws Error if prompt name already exists
     */
    async createPrompt(promptData: Omit<CustomPrompt, 'id'>): Promise<CustomPrompt> {
        // Check for duplicate names
        if (this.findByName(promptData.name)) {
            throw new Error(`A prompt with the name "${promptData.name}" already exists`);
        }

        const id = this.generatePromptId();
        const now = Date.now();

        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                this.db.run(
                    `INSERT INTO custom_prompts
                     (id, name, description, prompt, isEnabled, created, modified)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        id,
                        promptData.name,
                        promptData.description || '',
                        promptData.prompt,
                        promptData.isEnabled ? 1 : 0,
                        now,
                        now
                    ]
                );

                return { id, ...promptData };
            } catch (error) {
                console.error('[CustomPromptStorageService] Error writing to SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        this.ensureCustomPromptsSettings();
        const newPrompt: CustomPrompt = { id, ...promptData };
        this.settings.settings.customPrompts!.prompts.push(newPrompt);
        await this.settings.saveSettings();

        return newPrompt;
    }

    /**
     * Update an existing custom prompt
     * @param id Prompt ID
     * @param updates Partial prompt data to update
     * @throws Error if prompt not found or name conflict
     */
    async updatePrompt(id: string, updates: Partial<Omit<CustomPrompt, 'id'>>): Promise<void> {
        const now = Date.now();

        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                const fields: string[] = [];
                const values: any[] = [];

                if (updates.name !== undefined) {
                    fields.push('name = ?');
                    values.push(updates.name);
                }
                if (updates.description !== undefined) {
                    fields.push('description = ?');
                    values.push(updates.description);
                }
                if (updates.prompt !== undefined) {
                    fields.push('prompt = ?');
                    values.push(updates.prompt);
                }
                if (updates.isEnabled !== undefined) {
                    fields.push('isEnabled = ?');
                    values.push(updates.isEnabled ? 1 : 0);
                }

                fields.push('modified = ?');
                values.push(now);
                values.push(id);

                this.db.run(
                    `UPDATE custom_prompts SET ${fields.join(', ')} WHERE id = ?`,
                    values
                );

                return;
            } catch (error) {
                console.error('[CustomPromptStorageService] Error updating in SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        this.ensureCustomPromptsSettings();
        const prompts = this.settings.settings.customPrompts!.prompts;
        const index = prompts.findIndex(prompt => prompt.id === id);

        if (index === -1) {
            throw new Error(`Prompt with ID "${id}" not found`);
        }

        // Check for name conflicts if name is being updated
        if (updates.name && updates.name !== prompts[index].name) {
            const existingPrompt = this.findByName(updates.name);
            if (existingPrompt && existingPrompt.id !== id) {
                throw new Error(`A prompt with the name "${updates.name}" already exists`);
            }
        }

        prompts[index] = { ...prompts[index], ...updates };
        await this.settings.saveSettings();
    }

    /**
     * Delete a custom prompt
     * @param id Prompt ID
     */
    async deletePrompt(id: string): Promise<void> {
        // Try SQLite first if available
        if (this.db && this.migrated) {
            try {
                this.db.run('DELETE FROM custom_prompts WHERE id = ?', [id]);
                return;
            } catch (error) {
                console.error('[CustomPromptStorageService] Error deleting from SQLite, falling back to data.json:', error);
            }
        }

        // Fallback to data.json
        this.ensureCustomPromptsSettings();
        const prompts = this.settings.settings.customPrompts!.prompts;
        const index = prompts.findIndex(prompt => prompt.id === id);

        if (index !== -1) {
            prompts.splice(index, 1);
            await this.settings.saveSettings();
        }
    }

    /**
     * Toggle enabled state of a prompt
     * @param id Prompt ID
     * @returns Updated prompt
     * @throws Error if prompt not found
     */
    async togglePrompt(id: string): Promise<CustomPrompt> {
        const prompt = this.getPromptByNameOrId(id);
        if (!prompt) {
            throw new Error(`Prompt "${id}" not found (searched by both name and ID)`);
        }

        await this.updatePrompt(prompt.id, { isEnabled: !prompt.isEnabled });
        return { ...prompt, isEnabled: !prompt.isEnabled };
    }

    /**
     * Check if custom prompts are enabled globally
     * @returns True if enabled
     */
    isEnabled(): boolean {
        this.ensureCustomPromptsSettings();
        return this.settings.settings.customPrompts?.enabled || false;
    }

    /**
     * Enable or disable custom prompts globally
     * @param enabled Whether to enable custom prompts
     */
    async setEnabled(enabled: boolean): Promise<void> {
        this.ensureCustomPromptsSettings();
        this.settings.settings.customPrompts!.enabled = enabled;
        await this.settings.saveSettings();
    }

    /**
     * Ensure custom prompts settings exist with defaults
     */
    private ensureCustomPromptsSettings(): void {
        if (!this.settings.settings.customPrompts) {
            this.settings.settings.customPrompts = { ...DEFAULT_CUSTOM_PROMPTS_SETTINGS };
        }
    }

    /**
     * Generate a unique ID for a prompt
     * @returns Unique string ID
     */
    private generatePromptId(): string {
        return `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}
