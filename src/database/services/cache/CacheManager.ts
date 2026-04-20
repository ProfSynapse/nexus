import { Vault, App, EventRef, TFile } from 'obsidian';
import { EntityCache } from './EntityCache';
import { VaultFileIndex } from './VaultFileIndex';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { MemoryService } from '../../../agents/memoryManager/services/MemoryService';
import { PrefetchManager } from './PrefetchManager';

export interface CacheManagerOptions {
    enableEntityCache?: boolean;
    enableFileIndex?: boolean;
    enablePrefetch?: boolean;
    entityCacheTTL?: number;
    maxCacheSize?: number;
}

export class CacheManager {
    private vault: Vault;
    private entityCache: EntityCache | null = null;
    private vaultFileIndex: VaultFileIndex | null = null;
    private prefetchManager: PrefetchManager | null = null;
    private isInitialized = false;
    private vaultEventRefs: EventRef[] = [];
    private entityCacheEventRefs: EventRef[] = [];

    constructor(
        private app: App,
        private workspaceService: WorkspaceService,
        private memoryService: MemoryService,
        private options: CacheManagerOptions = {}
    ) {
        this.vault = app.vault;
        // Default options
        this.options.enableEntityCache = options.enableEntityCache ?? true;
        this.options.enableFileIndex = options.enableFileIndex ?? true;
        this.options.enablePrefetch = options.enablePrefetch ?? true;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        // Initialize EntityCache
        if (this.options.enableEntityCache) {
            this.entityCache = new EntityCache(
                this.vault,
                this.workspaceService,
                this.memoryService,
                {
                    ttl: this.options.entityCacheTTL,
                    maxSize: this.options.maxCacheSize
                }
            );
        }

        // Initialize VaultFileIndex
        if (this.options.enableFileIndex) {
            this.vaultFileIndex = new VaultFileIndex(this.vault, this.app);
            await this.vaultFileIndex.initialize();

            // Set up file event listeners
            this.setupFileEventListeners();
        }

        // Initialize PrefetchManager
        if (this.options.enablePrefetch && this.entityCache) {
            this.prefetchManager = new PrefetchManager(
                this,
                this.workspaceService,
                this.memoryService
            );

            // Set up prefetch listeners
            this.setupPrefetchListeners();
        }

        this.isInitialized = true;
    }

    private setupFileEventListeners(): void {
        const vaultFileIndex = this.vaultFileIndex;
        if (!vaultFileIndex) return;

        // Listen for file events from Obsidian
        this.vaultEventRefs.push(
            this.vault.on('create', (file) => {
                if (file instanceof TFile && (file.extension === 'md' || file.extension === 'canvas')) {
                    void vaultFileIndex.updateFile(file);
                }
            })
        );

        this.vaultEventRefs.push(
            this.vault.on('delete', (file) => {
                vaultFileIndex.removeFile(file.path);
                // Also invalidate entity cache for files
                if (this.entityCache) {
                    this.entityCache.invalidateFile(file.path);
                }
            })
        );

        this.vaultEventRefs.push(
            this.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && (file.extension === 'md' || file.extension === 'canvas')) {
                    void vaultFileIndex.renameFile(oldPath, file.path);
                }
            })
        );

        this.vaultEventRefs.push(
            this.vault.on('modify', (file) => {
                if (file instanceof TFile && (file.extension === 'md' || file.extension === 'canvas')) {
                    void vaultFileIndex.updateFile(file);
                }
            })
        );
    }

    private setupPrefetchListeners(): void {
        const entityCache = this.entityCache;
        const prefetchManager = this.prefetchManager;
        if (!entityCache || !prefetchManager) return;

        // Listen for entity cache events to trigger prefetching
        this.entityCacheEventRefs.push(
            entityCache.on('workspace:preloaded', (workspaceId) => {
                void prefetchManager.onWorkspaceLoaded(workspaceId as string);
            })
        );

        this.entityCacheEventRefs.push(
            entityCache.on('session:preloaded', (sessionId) => {
                void prefetchManager.onSessionLoaded(sessionId as string);
            })
        );

        this.entityCacheEventRefs.push(
            entityCache.on('state:preloaded', (stateId) => {
                void prefetchManager.onStateLoaded(stateId as string);
            })
        );
    }

    // Entity cache methods
    async preloadWorkspace(workspaceId: string): Promise<void> {
        if (!this.entityCache) {
            throw new Error('EntityCache not initialized');
        }
        await this.entityCache.preloadWorkspace(workspaceId);
    }

    async preloadSession(sessionId: string): Promise<void> {
        if (!this.entityCache) {
            throw new Error('EntityCache not initialized');
        }
        await this.entityCache.preloadSession(sessionId);
    }

    async preloadState(stateId: string): Promise<void> {
        if (!this.entityCache) {
            throw new Error('EntityCache not initialized');
        }
        await this.entityCache.preloadState(stateId);
    }

    getCachedWorkspace(workspaceId: string): ReturnType<EntityCache['getWorkspace']> | null {
        return this.entityCache?.getWorkspace(workspaceId);
    }

    getCachedSession(sessionId: string): ReturnType<EntityCache['getSession']> | null {
        return this.entityCache?.getSession(sessionId);
    }

    getCachedState(stateId: string): ReturnType<EntityCache['getState']> | null {
        return this.entityCache?.getState(stateId);
    }

    // File index methods
    getFileMetadata(filePath: string): ReturnType<VaultFileIndex['getFile']> | null {
        return this.vaultFileIndex?.getFile(filePath);
    }

    getKeyFiles(): ReturnType<VaultFileIndex['getKeyFiles']> {
        return this.vaultFileIndex?.getKeyFiles() || [];
    }

    getRecentFiles(limit?: number, folderPath?: string): ReturnType<VaultFileIndex['getRecentFiles']> {
        return this.vaultFileIndex?.getRecentFiles(limit, folderPath) || [];
    }

    getFilesInFolder(folderPath: string, recursive = false): ReturnType<VaultFileIndex['getFilesInFolder']> {
        return this.vaultFileIndex?.getFilesInFolder(folderPath, recursive) || [];
    }

    searchFiles(predicate: (file: unknown) => boolean): ReturnType<VaultFileIndex['searchFiles']> {
        return this.vaultFileIndex?.searchFiles(predicate) || [];
    }

    getFilesWithMetadata(filePaths: string[]): ReturnType<VaultFileIndex['getFilesWithMetadata']> {
        return this.vaultFileIndex?.getFilesWithMetadata(filePaths) || [];
    }

    // Cache warming
    async warmCache(workspaceId?: string): Promise<void> {
        // If a specific workspace is provided, preload it
        if (workspaceId) {
            await this.preloadWorkspace(workspaceId);
        }

        // Preload key files metadata
        if (this.vaultFileIndex) {
            const keyFiles = this.getKeyFiles();
            const keyFilePaths = keyFiles.map((f) => f.path);
            this.vaultFileIndex.warmup(keyFilePaths);
        }
    }

    // Cache management
    invalidateWorkspace(workspaceId: string): void {
        this.entityCache?.invalidateWorkspace(workspaceId);
    }

    invalidateSession(sessionId: string): void {
        this.entityCache?.invalidateSession(sessionId);
    }

    invalidateState(stateId: string): void {
        this.entityCache?.invalidateState(stateId);
    }

    clearCache(): void {
        this.entityCache?.clear();
        this.vaultFileIndex?.clear();
    }

    // Stats
    getStats(): {
        entityCache: {
            workspaces: number;
            sessions: number;
            states: number;
            files: number;
        } | null;
        fileIndex: ReturnType<VaultFileIndex['getStats']> | null;
        prefetch: ReturnType<PrefetchManager['getStats']> | null;
    } {
        return {
            entityCache: this.entityCache ? {
                workspaces: this.entityCache['workspaceCache'].size,
                sessions: this.entityCache['sessionCache'].size,
                states: this.entityCache['stateCache'].size,
                files: this.entityCache['fileMetadataCache'].size
            } : null,
            fileIndex: this.vaultFileIndex?.getStats() || null,
            prefetch: this.prefetchManager?.getStats() || null
        };
    }

    // Check if caches are ready
    isReady(): boolean {
        const entityCacheReady = !this.options.enableEntityCache || !!this.entityCache;
        const fileIndexReady = !this.options.enableFileIndex || this.vaultFileIndex?.isReady() || false;
        return this.isInitialized && entityCacheReady && fileIndexReady;
    }

    // Cleanup resources
    cleanup(): void {
        // Unregister vault event listeners
        for (const ref of this.vaultEventRefs) {
            this.vault.offref(ref);
        }
        this.vaultEventRefs = [];

        // Unregister entity cache event listeners
        if (this.entityCache) {
            for (const ref of this.entityCacheEventRefs) {
                this.entityCache.offref(ref);
            }
        }
        this.entityCacheEventRefs = [];

        // Cleanup VaultFileIndex and its metadata cache events
        if (this.vaultFileIndex) {
            this.vaultFileIndex.cleanup();
            this.vaultFileIndex = null;
        }

        // Clear entity cache
        if (this.entityCache) {
            this.entityCache.clear();
            this.entityCache = null;
        }

        // Reset prefetch manager
        if (this.prefetchManager) {
            this.prefetchManager.clearQueue();
            this.prefetchManager = null;
        }

        this.isInitialized = false;
    }
}
