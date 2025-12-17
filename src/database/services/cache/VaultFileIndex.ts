import { Events, Vault, TFile, TFolder, FileStats, MetadataCache, App, EventRef } from 'obsidian';

export interface IndexedFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    parent: string;
    modified: number;
    created: number;
    size: number;
    isKeyFile: boolean;
    tags?: string[];
    aliases?: string[];
    frontmatter?: any;
    backlinks?: string[];
    forwardLinks?: string[];
}

export interface IndexStats {
    totalFiles: number;
    keyFiles: number;
    lastUpdated: number;
    indexingTime: number;
}

export class VaultFileIndex extends Events {
    private fileIndex = new Map<string, IndexedFile>();
    private keyFilePatterns = [
        /readme\.md$/i,
        /index\.md$/i,
        /\.canvas$/,
        /overview\.md$/i,
        /summary\.md$/i,
        /main\.md$/i
    ];
    
    private folderIndex = new Map<string, string[]>(); // folder path -> file paths
    private tagIndex = new Map<string, string[]>(); // tag -> file paths
    private stats: IndexStats = {
        totalFiles: 0,
        keyFiles: 0,
        lastUpdated: 0,
        indexingTime: 0
    };

    private isIndexing = false;
    private indexPromise: Promise<void> | null = null;
    private metadataEventRefs: EventRef[] = [];

    constructor(private vault: Vault, private app?: App) {
        super();
    }

    async initialize(): Promise<void> {
        if (this.isIndexing) {
            return this.indexPromise || Promise.resolve();
        }

        this.isIndexing = true;
        const startTime = Date.now();

        this.indexPromise = this.buildIndex().then(() => {
            this.stats.indexingTime = Date.now() - startTime;
            this.stats.lastUpdated = Date.now();
            this.isIndexing = false;
            this.indexPromise = null;
            this.setupMetadataCacheEvents();
            this.trigger('index:ready', this.stats);
        }).catch(error => {
            console.error('Error building file index:', error);
            this.isIndexing = false;
            this.indexPromise = null;
            throw error;
        });

        return this.indexPromise;
    }

    private async buildIndex(): Promise<void> {
        this.clear();
        
        const files = this.vault.getFiles();
        const markdownFiles = files.filter(file => file.extension === 'md' || file.extension === 'canvas');
        
        // First pass: Create basic index entries
        for (const file of markdownFiles) {
            await this.indexFile(file, false);
        }


        // Second pass: Process metadata for key files (lazy load for others)
        const keyFiles = Array.from(this.fileIndex.values()).filter(f => f.isKeyFile);
        await Promise.all(keyFiles.map(f => this.loadFileMetadata(f.path)));

        this.updateStats();
        this.trigger('index:built', this.stats);
    }

    private async indexFile(file: TFile, loadMetadata = false): Promise<void> {
        const isKeyFile = this.keyFilePatterns.some(pattern => pattern.test(file.path));
        
        const indexed: IndexedFile = {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
            parent: file.parent?.path || '/',
            modified: file.stat.mtime,
            created: file.stat.ctime,
            size: file.stat.size,
            isKeyFile
        };

        this.fileIndex.set(file.path, indexed);

        // Update folder index
        const folderPath = file.parent?.path || '/';
        if (!this.folderIndex.has(folderPath)) {
            this.folderIndex.set(folderPath, []);
        }
        this.folderIndex.get(folderPath)!.push(file.path);

        // Load metadata if requested or if it's a key file
        if (loadMetadata || isKeyFile) {
            await this.loadFileMetadata(file.path);
        }
    }

    private async loadFileMetadata(filePath: string): Promise<void> {
        const file = this.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        const indexed = this.fileIndex.get(filePath);
        if (!indexed) return;

        try {
            // Load frontmatter - Note: getFileCache may not be available in all vault types
            const cache = this.app?.metadataCache?.getFileCache(file);
            if (cache) {
                indexed.frontmatter = cache.frontmatter;
                indexed.tags = cache.tags?.map((t: { tag: string }) => t.tag) || [];
                indexed.aliases = cache.frontmatter?.aliases || [];

                // Update tag index
                if (indexed.tags) {
                    indexed.tags.forEach(tag => {
                        if (!this.tagIndex.has(tag)) {
                            this.tagIndex.set(tag, []);
                        }
                        this.tagIndex.get(tag)!.push(filePath);
                    });
                }

                // Extract links
                indexed.forwardLinks = cache.links?.map((l: { link: string }) => l.link) || [];
            }
        } catch (error) {
            console.error(`Error loading metadata for ${filePath}:`, error);
        }
    }

    // File operations
    async updateFile(file: TFile): Promise<void> {
        await this.indexFile(file, true);
        this.updateStats();
        this.trigger('file:updated', file.path);
    }

    removeFile(filePath: string): void {
        const indexed = this.fileIndex.get(filePath);
        if (!indexed) return;

        // Remove from main index
        this.fileIndex.delete(filePath);

        // Remove from folder index
        const folderFiles = this.folderIndex.get(indexed.parent);
        if (folderFiles) {
            const index = folderFiles.indexOf(filePath);
            if (index > -1) {
                folderFiles.splice(index, 1);
            }
        }

        // Remove from tag index
        indexed.tags?.forEach(tag => {
            const tagFiles = this.tagIndex.get(tag);
            if (tagFiles) {
                const index = tagFiles.indexOf(filePath);
                if (index > -1) {
                    tagFiles.splice(index, 1);
                }
            }
        });

        this.updateStats();
        this.trigger('file:removed', filePath);
    }

    async renameFile(oldPath: string, newPath: string): Promise<void> {
        const indexed = this.fileIndex.get(oldPath);
        if (!indexed) return;

        // Remove old entry
        this.removeFile(oldPath);

        // Add new entry
        const file = this.vault.getAbstractFileByPath(newPath);
        if (file instanceof TFile) {
            await this.updateFile(file);
        }

        this.trigger('file:renamed', { oldPath, newPath });
    }

    // Query methods
    getFile(filePath: string): IndexedFile | undefined {
        return this.fileIndex.get(filePath);
    }

    getFiles(): IndexedFile[] {
        return Array.from(this.fileIndex.values());
    }

    getKeyFiles(): IndexedFile[] {
        return Array.from(this.fileIndex.values()).filter(f => f.isKeyFile);
    }


    getFilesInFolder(folderPath: string, recursive = false): IndexedFile[] {
        if (!recursive) {
            const filePaths = this.folderIndex.get(folderPath) || [];
            return filePaths.map(path => this.fileIndex.get(path)).filter(Boolean) as IndexedFile[];
        }

        // Recursive search
        const results: IndexedFile[] = [];
        const processFolder = (path: string) => {
            const filePaths = this.folderIndex.get(path) || [];
            filePaths.forEach(filePath => {
                const file = this.fileIndex.get(filePath);
                if (file) results.push(file);
            });

            // Process subfolders
            this.folderIndex.forEach((_, folderPath) => {
                if (folderPath.startsWith(path + '/')) {
                    processFolder(folderPath);
                }
            });
        };

        processFolder(folderPath);
        return results;
    }

    getFilesWithTag(tag: string): IndexedFile[] {
        const filePaths = this.tagIndex.get(tag) || [];
        return filePaths.map(path => this.fileIndex.get(path)).filter(Boolean) as IndexedFile[];
    }

    getRecentFiles(limit = 10, folderPath?: string): IndexedFile[] {
        const files = folderPath 
            ? this.getFilesInFolder(folderPath, true)
            : this.getFiles();

        return files
            .sort((a, b) => b.modified - a.modified)
            .slice(0, limit);
    }

    searchFiles(predicate: (file: IndexedFile) => boolean): IndexedFile[] {
        return Array.from(this.fileIndex.values()).filter(predicate);
    }

    // Batch operations
    async getFilesWithMetadata(filePaths: string[]): Promise<IndexedFile[]> {
        const results: IndexedFile[] = [];
        
        for (const path of filePaths) {
            let indexed = this.fileIndex.get(path);
            if (indexed) {
                // Ensure metadata is loaded
                if (!indexed.frontmatter && !indexed.tags) {
                    await this.loadFileMetadata(path);
                    indexed = this.fileIndex.get(path);
                }
                if (indexed) {
                    results.push(indexed);
                }
            }
        }

        return results;
    }

    // Stats and maintenance
    getStats(): IndexStats {
        return { ...this.stats };
    }

    private updateStats(): void {
        this.stats.totalFiles = this.fileIndex.size;
        this.stats.keyFiles = Array.from(this.fileIndex.values()).filter(f => f.isKeyFile).length;
        this.stats.lastUpdated = Date.now();
    }

    clear(): void {
        this.fileIndex.clear();
        this.folderIndex.clear();
        this.tagIndex.clear();
        this.stats = {
            totalFiles: 0,
            keyFiles: 0,
            lastUpdated: 0,
            indexingTime: 0
        };
        this.trigger('index:cleared');
    }

    // Performance helpers
    async warmup(filePaths: string[]): Promise<void> {
        // Preload metadata for specified files
        await Promise.all(
            filePaths.map(path => this.loadFileMetadata(path))
        );
    }

    isReady(): boolean {
        return !this.isIndexing && this.fileIndex.size > 0;
    }

    /**
     * Set up metadata cache event listeners for real-time updates
     */
    private setupMetadataCacheEvents(): void {
        if (!this.app?.metadataCache) {
            return;
        }

        const metadataCache = this.app.metadataCache;

        // Listen for metadata changes (tags, frontmatter, links)
        const metadataChangedRef = metadataCache.on('changed', (file: TFile) => {
            this.handleMetadataChanged(file);
        });

        // Listen for resolved metadata (when a file's metadata is fully processed)
        const resolvedRef = metadataCache.on('resolved', () => {
            this.handleMetadataResolved();
        });

        // Store references for cleanup
        this.metadataEventRefs = [
            metadataChangedRef,
            resolvedRef
        ];
    }

    /**
     * Handle metadata cache changes for a specific file
     */
    private async handleMetadataChanged(file: TFile): Promise<void> {
        const indexed = this.fileIndex.get(file.path);
        if (!indexed) {
            // File not in our index yet, add it
            await this.indexFile(file, true);
            return;
        }

        // Clear old tag index entries for this file
        if (indexed.tags) {
            indexed.tags.forEach(tag => {
                const tagFiles = this.tagIndex.get(tag);
                if (tagFiles) {
                    const index = tagFiles.indexOf(file.path);
                    if (index > -1) {
                        tagFiles.splice(index, 1);
                        if (tagFiles.length === 0) {
                            this.tagIndex.delete(tag);
                        }
                    }
                }
            });
        }

        // Reload metadata and update index
        await this.loadFileMetadata(file.path);
        this.updateStats();
        this.trigger('metadata:updated', file.path, indexed);
    }

    /**
     * Handle when metadata cache resolution is complete
     */
    private handleMetadataResolved(): void {
        this.trigger('metadata:resolved');
    }

    /**
     * Clean up metadata cache event listeners
     */
    cleanup(): void {
        // Remove all metadata event listeners
        if (this.app?.metadataCache) {
            this.metadataEventRefs.forEach(eventRef => {
                this.app!.metadataCache.offref(eventRef);
            });
        }
        this.metadataEventRefs = [];

        // Clear all data
        this.clear();
    }
}