import { CustomPrompt, CustomPromptsSettings, DEFAULT_CUSTOM_PROMPTS_SETTINGS } from '../../../types';
import { Settings } from '../../../settings';
import type { MigratableDatabase } from '../../../database/schema/SchemaMigrator';

type DbRowValue = string | number | null;
type DbRow = DbRowValue[];
type DbResultSet = { values: DbRow[] };
type RawDatabase = {
    prepare(sql: string): {
        bind(params?: DbRowValue[]): void;
        step(): boolean;
        get(params: DbRowValue[]): DbRow;
        finalize(): void;
    };
};

/**
 * Database-like wrapper that adapts raw sqlite db to MigratableDatabase interface
 * Adds query() method for parameterized SELECT queries
 */
class DatabaseAdapter implements MigratableDatabase {
    constructor(private rawDb: RawDatabase) {}

    exec(sql: string): DbResultSet[] {
        const stmt = this.rawDb.prepare(sql);
        const results: DbRow[] = [];
        while (stmt.step()) {
            results.push(stmt.get([]));
        }
        stmt.finalize();
        return results.length > 0 ? [{ values: results }] : [];
    }

    run(sql: string, params?: DbRowValue[]): void {
        const stmt = this.rawDb.prepare(sql);
        if (params?.length) {
            stmt.bind(params);
        }
        stmt.step();
        stmt.finalize();
    }

    /** Query with parameters (extension of MigratableDatabase) */
    query(sql: string, params?: DbRowValue[]): DbResultSet[] {
        const stmt = this.rawDb.prepare(sql);
        if (params?.length) {
            stmt.bind(params);
        }
        const results: DbRow[] = [];
        while (stmt.step()) {
            results.push(stmt.get([]));
        }
        stmt.finalize();
        return results.length > 0 ? [{ values: results }] : [];
    }
}

type DatabaseInput = MigratableDatabase | { db?: RawDatabase } | null;

/**
 * Service for managing custom prompt storage and persistence
 * Migrated to SQLite-based storage with data.json fallback for backward compatibility
 */
export class CustomPromptStorageService {
    private db: MigratableDatabase | null;
    private settings: Settings;
    private migrated = false;
    private onChange: (() => void) | null = null;

    constructor(rawDb: DatabaseInput, settings: Settings) {
        // Wrap raw db in adapter if provided
        if (!rawDb) {
            this.db = null;
        } else if ('exec' in rawDb && 'run' in rawDb) {
            this.db = rawDb;
        } else if ('db' in rawDb && rawDb.db) {
            this.db = new DatabaseAdapter(rawDb.db);
        } else {
            this.db = null;
        }
        this.settings = settings;
        this.initialize();
    }

    /**
     * Register a change listener fired after any prompt mutation (create/update/delete/toggle/setEnabled).
     * Best-effort notification for consumers that need to refresh derived data (e.g. ToolManager schema).
     * Replaces any previously registered listener. Pass null to detach.
     */
    setOnChange(listener: (() => void) | null): void {
        this.onChange = listener;
    }

    /**
     * Fire the change listener safely — errors are swallowed so mutations never fail due to listener bugs.
     */
    private notifyChange(): void {
        if (!this.onChange) return;
        try {
            this.onChange();
        } catch (error) {
            console.error('[CustomPromptStorageService] onChange listener threw:', error);
        }
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
                const dbWithQuery = this.db as MigratableDatabase & { query?: (sql: string, params?: unknown[]) => { values: unknown[][] }[] };
                const result = dbWithQuery.query
                    ? dbWithQuery.query('SELECT * FROM custom_prompts WHERE id = ? OR name = ? LIMIT 1', [identifier, identifier])
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

        // Best-effort SQLite write
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
            } catch (error) {
                console.error('[CustomPromptStorageService] Error writing to SQLite:', error);
            }
        }

        // Always write to data.json (source of truth for cross-device sync)
        const customPromptsSettings = this.ensureCustomPromptsSettings();
        const newPrompt: CustomPrompt = { id, ...promptData };
        customPromptsSettings.prompts.push(newPrompt);
        await this.settings.saveSettings();

        this.notifyChange();
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

        // Best-effort SQLite write
        if (this.db && this.migrated) {
            try {
                const fields: string[] = [];
                const values: DbRowValue[] = [];

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
            } catch (error) {
                console.error('[CustomPromptStorageService] Error updating in SQLite:', error);
            }
        }

        // Always write to data.json (source of truth for cross-device sync)
        this.ensureCustomPromptsSettings();
        const prompts = this.getCustomPrompts();
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

        this.notifyChange();
    }

    /**
     * Delete a custom prompt
     * @param id Prompt ID
     */
    async deletePrompt(id: string): Promise<void> {
        // Best-effort SQLite write
        if (this.db && this.migrated) {
            try {
                this.db.run('DELETE FROM custom_prompts WHERE id = ?', [id]);
            } catch (error) {
                console.error('[CustomPromptStorageService] Error deleting from SQLite:', error);
            }
        }

        // Always write to data.json (source of truth for cross-device sync)
        this.ensureCustomPromptsSettings();
        const prompts = this.getCustomPrompts();
        const index = prompts.findIndex(prompt => prompt.id === id);

        if (index !== -1) {
            prompts.splice(index, 1);
            await this.settings.saveSettings();
            this.notifyChange();
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
        return this.ensureCustomPromptsSettings().enabled;
    }

    /**
     * Enable or disable custom prompts globally
     * @param enabled Whether to enable custom prompts
     */
    async setEnabled(enabled: boolean): Promise<void> {
        this.ensureCustomPromptsSettings().enabled = enabled;
        await this.settings.saveSettings();
        this.notifyChange();
    }

    /**
     * Ensure custom prompts settings exist with defaults
     */
    private ensureCustomPromptsSettings(): CustomPromptsSettings {
        if (!this.settings.settings.customPrompts) {
            this.settings.settings.customPrompts = { ...DEFAULT_CUSTOM_PROMPTS_SETTINGS };
        }
        return this.settings.settings.customPrompts;
    }

    private getCustomPrompts(): CustomPrompt[] {
        return this.ensureCustomPromptsSettings().prompts;
    }

    /**
     * Generate a unique ID for a prompt
     * @returns Unique string ID
     */
    private generatePromptId(): string {
        return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
}
