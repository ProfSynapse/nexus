/**
 * Location: src/core/ServiceManager.ts
 * 
 * ServiceManager - Unified service management facade that consolidates all service management capabilities
 * 
 * This facade unifies 4 competing service management systems into a single, clean interface:
 * - ServiceContainer (enhanced DI container with lifecycle management)
 * - LazyServiceManager (stage-based loading with coordination)
 * - SimpleServiceManager (3-tier architecture with immediate/fast/background)
 * - Lazy-initialization system (descriptor-based configuration)
 * 
 * Key features:
 * - Unified registration interface supporting all existing patterns
 * - Stage-based initialization (immediate, fast, background, on-demand)
 * - Dependency injection with circular dependency detection
 * - Lifecycle management with proper cleanup
 * - Service descriptors for configuration-driven service definitions
 * - Backward compatibility with all existing systems
 * - Type-safe generics throughout
 * 
 * Used by:
 * - Main plugin class for unified service coordination
 * - All service consumers through single interface
 * - Settings components for service management UI
 * - Agents and modes for service dependencies
 */

import { App, Plugin } from 'obsidian';
import { ServiceContainer, IServiceContainer, ServiceFactory, LazyFactory, IServiceFactory } from './ServiceContainer';
// All service management now handled through ServiceContainer - no external dependencies needed

// Core interfaces for unified service management
export interface IServiceDescriptor<T = any> {
    name: string;
    dependencies?: string[];
    stage?: ServiceStage;
    singleton?: boolean;
    create(): Promise<T> | T;
}

export interface IServiceManager {
    // Registration methods - unified interface
    registerService<T>(descriptor: IServiceDescriptor<T>): Promise<void>;
    registerFactory<T>(name: string, factory: ServiceFactory<T>, options?: ServiceRegistrationOptions): void;
    registerLazy<T>(name: string, factory: LazyFactory<T>): void;
    registerServiceFactory<T>(name: string, factory: IServiceFactory<T>): void;
    
    // Service retrieval - unified interface
    getService<T>(name: string): Promise<T>;
    getServiceIfReady<T>(name: string): T | null;
    getServiceSync<T>(name: string): T | null; // For immediate services only
    
    // Lifecycle management
    initializeServices(): Promise<void>;
    initializeStage(stage: ServiceStage): Promise<void>;
    
    // Service status and introspection
    isServiceReady(name: string): boolean;
    isStageReady(stage: ServiceStage): boolean;
    getServiceStatus(name: string): ServiceStatus;
    getAllServiceStatus(): Record<string, ServiceStatus>;
    
    // Lifecycle operations
    start(): Promise<void>;
    stop(): Promise<void>;
    cleanup(): Promise<void>;
}

export interface ServiceRegistrationOptions {
    singleton?: boolean;
    dependencies?: string[];
    stage?: ServiceStage;
    timeout?: number;
}

export enum ServiceStage {
    IMMEDIATE = 'immediate',       // < 100ms - essential for plugin loading
    FAST = 'fast',                // ~300ms - important for UX
    BACKGROUND = 'background',    // ~2-5s - full functionality  
    ON_DEMAND = 'on_demand'       // Only when needed
}

export interface ServiceStatus {
    name: string;
    stage: ServiceStage;
    ready: boolean;
    initialized: boolean;
    loading: boolean;
    error?: Error;
    dependencies: string[];
    dependents: string[];
    registrationTime?: number;
    initializationTime?: number;
}

/**
 * ServiceManager - Unified facade for all service management operations
 * 
 * Architecture:
 * - Uses ServiceContainer as the core DI engine
 * - Integrates ServiceLifecycleManager for advanced lifecycle coordination
 * - Supports all existing registration patterns
 * - Provides unified interface for service consumers
 * - Maintains backward compatibility with all existing systems
 */
export class ServiceManager implements IServiceManager {
    private container: IServiceContainer;
    private serviceStages = new Map<string, ServiceStage>();
    private isStarted = false;
    private isInitializing = false;
    private initializationPromise: Promise<void> | null = null;
    
    constructor(
        private app: App,
        private plugin: Plugin
    ) {
        // Initialize core components
        this.container = new ServiceContainer();
    }

    /**
     * Register service using unified descriptor interface
     * Supports all existing registration patterns through a single interface
     */
    async registerService<T>(descriptor: IServiceDescriptor<T>): Promise<void> {
        const stage = descriptor.stage || ServiceStage.BACKGROUND;
        const singleton = descriptor.singleton !== false; // Default to singleton
        
        // Store stage information
        this.serviceStages.set(descriptor.name, stage);
        
        // Register with ServiceContainer using factory pattern
        this.container.register<T>(
            descriptor.name,
            async (dependencies: Record<string, any>) => {
                // Resolve dependencies if needed
                if (descriptor.dependencies && descriptor.dependencies.length > 0) {
                    const resolvedDeps: Record<string, any> = {};
                    for (const depName of descriptor.dependencies) {
                        resolvedDeps[depName] = await this.getService(depName);
                    }
                    
                    // Create service instance
                    const result = descriptor.create();
                    return result instanceof Promise ? await result : result;
                }
                
                const result = descriptor.create();
                return result instanceof Promise ? await result : result;
            },
            {
                singleton,
                dependencies: descriptor.dependencies || []
            }
        );
        
        // Service registered with ServiceContainer - no legacy compatibility needed
    }

    /**
     * Register service using traditional factory pattern
     */
    registerFactory<T>(name: string, factory: ServiceFactory<T>, options?: ServiceRegistrationOptions): void {
        const stage = options?.stage || ServiceStage.BACKGROUND;
        this.serviceStages.set(name, stage);
        
        this.container.register<T>(name, factory, {
            singleton: options?.singleton,
            dependencies: options?.dependencies
        });
    }

    /**
     * Register lazy-loaded service
     */
    registerLazy<T>(name: string, factory: LazyFactory<T>): void {
        this.serviceStages.set(name, ServiceStage.ON_DEMAND);
        this.container.registerLazy<T>(name, factory);
    }

    /**
     * Register service using IServiceFactory interface
     */
    registerServiceFactory<T>(name: string, factory: IServiceFactory<T>): void {
        this.serviceStages.set(name, ServiceStage.BACKGROUND);
        this.container.registerFactory<T>(name, factory);
    }

    /**
     * Get service instance - unified retrieval method
     */
    async getService<T>(name: string): Promise<T> {
        try {
            return await this.container.get<T>(name);
        } catch (error) {
            console.error(`[ServiceManager] Failed to get service '${name}':`, error);
            throw error;
        }
    }

    /**
     * Get service if already initialized (non-blocking)
     */
    getServiceIfReady<T>(name: string): T | null {
        return this.container.getIfReady<T>(name);
    }

    getServiceSync<T>(name: string): T | null {
        const stage = this.serviceStages.get(name);
        if (stage !== ServiceStage.IMMEDIATE) {
            return null;
        }

        return this.container.getIfReady<T>(name);
    }

    async initializeServices(): Promise<void> {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        if (this.isInitializing) {
            return;
        }
        
        this.isInitializing = true;
        
        this.initializationPromise = this.performInitialization();
        
        try {
            await this.initializationPromise;
        } finally {
            this.isInitializing = false;
            this.initializationPromise = null;
        }
    }

    private async performInitialization(): Promise<void> {
        try {
            await this.initializeStage(ServiceStage.IMMEDIATE);
            await this.initializeStage(ServiceStage.FAST);

            setTimeout(() => {
                this.initializeStage(ServiceStage.BACKGROUND).catch(error => {
                    console.error('[ServiceManager] Background service initialization failed:', error);
                });
            }, 0);

        } catch (error) {
            console.error('[ServiceManager] Service initialization failed:', error);
            throw error;
        }
    }

    /**
     * Initialize all services in a specific stage
     */
    async initializeStage(stage: ServiceStage): Promise<void> {
        const serviceNames = this.getServicesByStage(stage);
        if (serviceNames.length === 0) {
            return;
        }

        const stageStartTime = Date.now();
        // Initializing services for stage
        
        // Initialize services in parallel within stage, but respect dependencies
        const initPromises = serviceNames.map(async (serviceName) => {
            try {
                await this.getService(serviceName);
                // Service initialized successfully
            } catch (error) {
                console.error(`[ServiceManager] ✗ Failed to initialize ${serviceName}:`, error);
                throw error;
            }
        });
        
        await Promise.all(initPromises);
        
        const stageDuration = Date.now() - stageStartTime;
        // Stage initialization completed
    }

    /**
     * Check if service is ready
     */
    isServiceReady(name: string): boolean {
        return this.container.isReady(name);
    }

    /**
     * Check if all services in a stage are ready
     */
    isStageReady(stage: ServiceStage): boolean {
        const serviceNames = this.getServicesByStage(stage);
        return serviceNames.every(name => this.container.isReady(name));
    }

    /**
     * Get detailed service status
     */
    getServiceStatus(name: string): ServiceStatus {
        const containerMeta = this.container.getServiceMetadata(name);
        const stage = this.serviceStages.get(name) || ServiceStage.BACKGROUND;
        
        return {
            name,
            stage,
            ready: this.container.isReady(name),
            initialized: containerMeta?.initialized || false,
            loading: false, // TODO: Track loading state
            dependencies: containerMeta?.dependencies || [],
            dependents: containerMeta?.dependents || []
        };
    }

    /**
     * Get status of all services
     */
    getAllServiceStatus(): Record<string, ServiceStatus> {
        const status: Record<string, ServiceStatus> = {};
        
        for (const serviceName of this.container.getRegisteredServices()) {
            status[serviceName] = this.getServiceStatus(serviceName);
        }
        
        return status;
    }

    /**
     * Start the service manager
     */
    async start(): Promise<void> {
        if (this.isStarted) {
            return;
        }
        
        this.isStarted = true;
        // Service manager starting
        
        // Initialize services
        await this.initializeServices();
    }

    /**
     * Stop the service manager
     */
    async stop(): Promise<void> {
        if (!this.isStarted) {
            return;
        }
        
        // Service manager stopping
        
        // Stop services in reverse dependency order
        await this.cleanup();
        
        this.isStarted = false;
    }

    /**
     * Cleanup all services
     */
    async cleanup(): Promise<void> {
        try {
            // Container handles cleanup in proper dependency order
            this.container.clear();
            
            // Clear stage mappings
            this.serviceStages.clear();
            
            // Service cleanup completed
            
        } catch (error) {
            console.error('[ServiceManager] Cleanup error:', error);
            throw error;
        }
    }

    // Helper methods

    /**
     * Get services by stage
     */
    private getServicesByStage(stage: ServiceStage): string[] {
        const services: string[] = [];
        
        this.serviceStages.forEach((serviceStage, serviceName) => {
            if (serviceStage === stage) {
                services.push(serviceName);
            }
        });
        
        return services;
    }

    // Legacy stage mapping removed - all stage management now through ServiceStage enum

    // Compatibility methods for existing consumers

    /**
     * Compatibility method for LazyServiceManager interface
     */
    async get<T>(name: string): Promise<T> {
        return this.getService<T>(name);
    }

    /**
     * Compatibility method for SimpleServiceManager interface
     */
    getIfReady<T>(name: string): T | null {
        return this.getServiceIfReady<T>(name);
    }

    /**
     * Compatibility method for getting all initialized services
     */
    getAllInitialized(): Record<string, any> {
        const services: Record<string, any> = {};
        
        for (const serviceName of this.container.getReadyServices()) {
            const service = this.container.getIfReady(serviceName);
            if (service) {
                services[serviceName] = service;
            }
        }
        
        return services;
    }

    /**
     * Get container statistics
     */
    getStats() {
        return this.container.getStats();
    }

    /**
     * Get ready service names
     */
    getReadyServices(): string[] {
        return this.container.getReadyServices();
    }

    /**
     * Get registered service names
     */
    getRegisteredServices(): string[] {
        return this.container.getRegisteredServices();
    }

    /**
     * Validate dependency graph
     */
    validateDependencies(): { valid: boolean; cycles: string[] } {
        const result = this.container.validateDependencies();
        return {
            valid: result.isValid,
            cycles: result.errors
        };
    }

    /**
     * Pre-initialize services for better performance
     */
    async preInitializeServices(serviceNames: string[]): Promise<void> {
        await this.container.preInitializeMany(serviceNames);
    }

    /**
     * Initialize services in dependency order
     */
    async initializeInOrder(serviceNames: string[]): Promise<void> {
        await this.container.initializeInOrder(serviceNames);
    }

    /**
     * Export dependency graph for visualization
     */
    exportDependencyGraph(): { nodes: string[]; edges: Array<{ from: string; to: string }> } {
        return this.container.exportDependencyGraph();
    }
}