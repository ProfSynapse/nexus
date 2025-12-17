import { Events } from 'obsidian';
import { CacheManager } from './CacheManager';
import { WorkspaceService } from '../../../services/WorkspaceService';
import { MemoryService } from '../../../agents/memoryManager/services/MemoryService';
import { WorkspaceSession, WorkspaceState } from '../../types/session/SessionTypes';

export interface PrefetchOptions {
    maxConcurrentPrefetches?: number;
    prefetchDelay?: number;
    enableSmartPrefetch?: boolean;
}

export class PrefetchManager extends Events {
    private prefetchQueue: string[] = [];
    private isPrefetching = false;
    private prefetchHistory = new Map<string, number>(); // entityId -> last prefetch timestamp
    
    private readonly defaultMaxConcurrent = 3;
    private readonly defaultPrefetchDelay = 1000; // 1 second between prefetches
    private readonly prefetchCooldown = 5 * 60 * 1000; // 5 minutes cooldown

    constructor(
        private cacheManager: CacheManager,
        private workspaceService: WorkspaceService,
        private memoryService: MemoryService,
        private options: PrefetchOptions = {}
    ) {
        super();
        this.options.maxConcurrentPrefetches = options.maxConcurrentPrefetches || this.defaultMaxConcurrent;
        this.options.prefetchDelay = options.prefetchDelay || this.defaultPrefetchDelay;
        this.options.enableSmartPrefetch = options.enableSmartPrefetch ?? true;
    }

    /**
     * Called when a workspace is loaded - prefetch likely next items
     */
    async onWorkspaceLoaded(workspaceId: string): Promise<void> {
        if (!this.options.enableSmartPrefetch) return;

        try {
            // Get recent sessions for this workspace
            const sessionsResult = await this.memoryService.getSessions(workspaceId);
            const recentSessions = sessionsResult.items
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                .slice(0, 5);

            // Queue prefetch for recent sessions
            for (const session of recentSessions) {
                this.queuePrefetch('session', session.id);
            }

            // Start processing the queue
            this.processPrefetchQueue();
        } catch (error) {
            console.error('Error in onWorkspaceLoaded prefetch:', error);
        }
    }

    /**
     * Called when a session is loaded - prefetch associated data
     */
    async onSessionLoaded(sessionId: string): Promise<void> {
        if (!this.options.enableSmartPrefetch) return;

        try {
            // Get the session to find its workspace
            const session = await this.memoryService.getSession('default-workspace', sessionId);

            if (session && session.workspaceId) {
                // Prefetch the parent workspace if not already cached
                this.queuePrefetch('workspace', session.workspaceId);
            }

            // Get recent memory traces
            const tracesResult = await this.memoryService.getMemoryTraces(sessionId);
            const relatedFiles = new Set<string>();

            for (const trace of tracesResult.items) {
                const files =
                  (trace.metadata?.input?.files && Array.isArray(trace.metadata.input.files)
                    ? trace.metadata.input.files
                    : trace.metadata?.legacy?.relatedFiles) || [];
                files.forEach((f: string) => relatedFiles.add(f));
            }

            // Prefetch file metadata
            if (relatedFiles.size > 0) {
                await this.cacheManager.getFilesWithMetadata(Array.from(relatedFiles));
            }

            // Start processing the queue
            this.processPrefetchQueue();
        } catch (error) {
            console.error('Error in onSessionLoaded prefetch:', error);
        }
    }

    /**
     * Called when a state is loaded - prefetch related states
     */
    async onStateLoaded(stateId: string): Promise<void> {
        if (!this.options.enableSmartPrefetch) return;

        try {
            // Get the state to find related states
            const statesResult = await this.memoryService.getStates('default-workspace');
            const stateItem = statesResult.items.find(s => s.id === stateId);

            if (stateItem) {
                // Prefetch parent session
                if (stateItem.state.sessionId) {
                    this.queuePrefetch('session', stateItem.state.sessionId);
                }

                // Prefetch sibling states (same session)
                if (stateItem.state.sessionId) {
                    const siblingStates = statesResult.items
                        .filter(s => s.state.sessionId === stateItem.state.sessionId && s.id !== stateId)
                        .sort((a, b) => (b.state.timestamp ?? 0) - (a.state.timestamp ?? 0))
                        .slice(0, 3);

                    for (const sibling of siblingStates) {
                        this.queuePrefetch('state', sibling.id);
                    }
                }
            }

            // Start processing the queue
            this.processPrefetchQueue();
        } catch (error) {
            console.error('Error in onStateLoaded prefetch:', error);
        }
    }

    /**
     * Queue an entity for prefetching
     */
    private queuePrefetch(type: 'workspace' | 'session' | 'state', id: string): void {
        const key = `${type}:${id}`;
        
        // Check if recently prefetched
        const lastPrefetch = this.prefetchHistory.get(key);
        if (lastPrefetch && Date.now() - lastPrefetch < this.prefetchCooldown) {
            return; // Skip if recently prefetched
        }

        // Add to queue if not already there
        if (!this.prefetchQueue.includes(key)) {
            this.prefetchQueue.push(key);
            this.trigger('prefetch:queued', { type, id });
        }
    }

    /**
     * Process the prefetch queue
     */
    private async processPrefetchQueue(): Promise<void> {
        if (this.isPrefetching || this.prefetchQueue.length === 0) {
            return;
        }

        this.isPrefetching = true;

        try {
            // Process up to maxConcurrent items
            const itemsToProcess = this.prefetchQueue.splice(0, this.options.maxConcurrentPrefetches || this.defaultMaxConcurrent);
            
            const prefetchPromises = itemsToProcess.map(async (item) => {
                const [type, id] = item.split(':');
                
                try {
                    switch (type) {
                        case 'workspace':
                            await this.cacheManager.preloadWorkspace(id);
                            break;
                        case 'session':
                            await this.cacheManager.preloadSession(id);
                            break;
                        case 'state':
                            await this.cacheManager.preloadState(id);
                            break;
                    }
                    
                    // Record successful prefetch
                    this.prefetchHistory.set(item, Date.now());
                    this.trigger('prefetch:completed', { type, id });
                } catch (error) {
                    this.trigger('prefetch:failed', { type, id, error });
                }
            });

            await Promise.all(prefetchPromises);

            // If there are more items, continue after a delay
            if (this.prefetchQueue.length > 0) {
                setTimeout(() => {
                    this.isPrefetching = false;
                    this.processPrefetchQueue();
                }, this.options.prefetchDelay || this.defaultPrefetchDelay);
            } else {
                this.isPrefetching = false;
            }
        } catch (error) {
            console.error('Error processing prefetch queue:', error);
            this.isPrefetching = false;
        }
    }

    /**
     * Clear the prefetch queue
     */
    clearQueue(): void {
        this.prefetchQueue = [];
        this.isPrefetching = false;
        this.trigger('prefetch:queueCleared');
    }

    /**
     * Get prefetch statistics
     */
    getStats() {
        return {
            queueLength: this.prefetchQueue.length,
            isPrefetching: this.isPrefetching,
            historySize: this.prefetchHistory.size,
            recentPrefetches: Array.from(this.prefetchHistory.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([key, timestamp]) => ({
                    key,
                    timestamp,
                    age: Date.now() - timestamp
                }))
        };
    }
}
