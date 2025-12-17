/**
 * ServiceContainer - Enhanced dependency injection container with lazy loading and factory support
 * Location: src/core/ServiceContainer.ts
 * 
 * This service replaces the complex service registries and initialization coordination
 * with a unified, predictable dependency injection pattern. It provides clean service
 * lifecycle management and proper dependency resolution with multiple registration patterns.
 * 
 * Key features:
 * - Simple factory-based service registration
 * - Lazy loading capabilities with deferred initialization
 * - IServiceFactory pattern support for advanced factories
 * - Singleton and transient service support
 * - Dependency injection with type safety
 * - Circular dependency detection
 * - Promise-based duplicate initialization prevention
 * - Clean cleanup and lifecycle management
 * 
 * Registration Types:
 * - register(): Traditional factory with dependency injection
 * - registerLazy(): Lazy-loaded services with deferred creation
 * - registerFactory(): IServiceFactory pattern with advanced dependency management
 * 
 * Used by:
 * - Enhanced Plugin main class for service coordination
 * - Service initialization and dependency resolution
 * - Lazy loading patterns from LazyServiceManager
 * - Factory patterns from ServiceDescriptors
 * - Clean service lifecycle management
 * - Service cleanup during plugin unload
 */

export type ServiceFactory<T> = (dependencies: Record<string, any>) => T | Promise<T>;
export type LazyFactory<T> = () => Promise<T>;

export interface ServiceRegistration<T> {
  factory: ServiceFactory<T>;
  singleton: boolean;
  dependencies?: string[];
}

export interface IServiceFactory<T> {
  create(dependencies: Map<string, any>): Promise<T>;
  getRequiredDependencies(): string[];
}

export interface IServiceContainer {
  register<T>(name: string, factory: ServiceFactory<T>, options?: { singleton?: boolean; dependencies?: string[] }): void;
  registerLazy<T>(name: string, factory: LazyFactory<T>): void;
  registerFactory<T>(name: string, factory: IServiceFactory<T>): void;
  get<T>(name: string): Promise<T>;
  getLazy<T>(name: string): Promise<T>;
  getIfReady<T>(name: string): T | null;
  has(name: string): boolean;
  isReady(name: string): boolean;
  resolveDependencies(name: string): Promise<void>;
  
  // Additional methods required by ServiceManager
  getServiceMetadata(name: string): ServiceMetadata | null;
  getRegisteredServices(): string[];
  clear(): void;
  getReadyServices(): string[];
  getStats(): { registered: number; ready: number; failed: number };
  validateDependencies(): { isValid: boolean; errors: string[] };
  preInitializeMany(names: string[]): Promise<void>;
  initializeInOrder(names: string[]): Promise<void>;
  exportDependencyGraph(): { nodes: string[], edges: Array<{from: string, to: string}> };
}

export interface ServiceMetadata {
  name: string;
  singleton: boolean;
  initialized: boolean;
  dependencies: string[];
  dependents: string[];
}

/**
 * Enhanced dependency injection container with lazy loading and factory support
 * Replaces complex service registries with unified service management
 */
export class ServiceContainer implements IServiceContainer {
  private services = new Map<string, any>();
  private factories = new Map<string, ServiceRegistration<any>>();
  private lazyFactories = new Map<string, LazyFactory<any>>();
  private serviceFactories = new Map<string, IServiceFactory<any>>();
  private initializationStack: string[] = [];
  private dependencyGraph = new Map<string, Set<string>>();
  private pendingPromises = new Map<string, Promise<any>>();

  /**
   * Register service factory with optional dependencies
   */
  register<T>(
    name: string, 
    factory: ServiceFactory<T>, 
    options: {
      singleton?: boolean;
      dependencies?: string[];
    } = {}
  ): void {
    const singleton = options.singleton !== false; // Default to singleton
    const dependencies = options.dependencies || [];

    this.factories.set(name, {
      factory,
      singleton,
      dependencies
    });

    // Build dependency graph
    this.dependencyGraph.set(name, new Set(dependencies));
  }

  /**
   * Register lazy-loaded service factory
   * Services registered with this method are created on-demand without explicit dependencies
   */
  registerLazy<T>(name: string, factory: LazyFactory<T>): void {
    this.lazyFactories.set(name, factory);
    // Lazy services have no explicit dependencies - they manage their own resolution
    this.dependencyGraph.set(name, new Set());
  }

  /**
   * Register service using IServiceFactory interface
   * Supports the factory pattern with explicit dependency management
   */
  registerFactory<T>(name: string, factory: IServiceFactory<T>): void {
    const dependencies = factory.getRequiredDependencies();
    this.serviceFactories.set(name, factory);
    // Build dependency graph from factory
    this.dependencyGraph.set(name, new Set(dependencies));
  }

  /**
   * Get service instance with dependency resolution
   * Supports regular factories, lazy factories, and IServiceFactory pattern
   */
  async get<T>(name: string): Promise<T> {
    // Check if already instantiated (for singletons)
    if (this.services.has(name)) {
      return this.services.get(name);
    }

    // Check if there's a pending promise to avoid duplicate initialization
    if (this.pendingPromises.has(name)) {
      return this.pendingPromises.get(name);
    }

    // Try different registration types in order of preference
    const registration = this.factories.get(name);
    const lazyFactory = this.lazyFactories.get(name);
    const serviceFactory = this.serviceFactories.get(name);

    if (!registration && !lazyFactory && !serviceFactory) {
      const availableServices = [
        ...Array.from(this.factories.keys()),
        ...Array.from(this.lazyFactories.keys()),
        ...Array.from(this.serviceFactories.keys())
      ];
      throw new Error(`Service '${name}' not found. Available services: ${availableServices.join(', ')}`);
    }

    // Check for circular dependencies
    if (this.initializationStack.includes(name)) {
      const cycle = [...this.initializationStack, name].join(' -> ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }

    // Create and store promise to avoid duplicate initialization
    const promise = this.createServiceInstance<T>(name, registration, lazyFactory, serviceFactory);
    this.pendingPromises.set(name, promise);

    try {
      const instance = await promise;
      this.pendingPromises.delete(name);
      return instance;
    } catch (error) {
      this.pendingPromises.delete(name);
      throw error;
    }
  }

  /**
   * Get service using lazy loading pattern
   * Equivalent to get() but explicitly for lazy-registered services
   */
  async getLazy<T>(name: string): Promise<T> {
    return this.get<T>(name);
  }

  /**
   * Internal method to create service instance based on registration type
   */
  private async createServiceInstance<T>(
    name: string,
    registration: ServiceRegistration<any> | undefined,
    lazyFactory: LazyFactory<any> | undefined,
    serviceFactory: IServiceFactory<any> | undefined
  ): Promise<T> {
    // Add to initialization stack
    this.initializationStack.push(name);

    try {
      let instance: T;

      if (lazyFactory) {
        // Handle lazy factory (no dependency injection)
        instance = await lazyFactory();
        // Lazy factories are always treated as singletons
        this.services.set(name, instance);
      } else if (serviceFactory) {
        // Handle IServiceFactory pattern
        const dependencies = serviceFactory.getRequiredDependencies();
        const resolvedDependencies = new Map<string, any>();
        
        // Resolve dependencies
        for (const depName of dependencies) {
          const dependency = await this.get(depName);
          resolvedDependencies.set(depName, dependency);
        }

        instance = await serviceFactory.create(resolvedDependencies);
        // ServiceFactory instances are always treated as singletons
        this.services.set(name, instance);
      } else if (registration) {
        // Handle regular factory pattern
        const resolvedDependencies: Record<string, any> = {};
        const dependencies = registration.dependencies || [];
        
        // Resolve dependencies
        for (const depName of dependencies) {
          const dependency = await this.get(depName);
          resolvedDependencies[depName] = dependency;
        }

        instance = await registration.factory(resolvedDependencies);

        // Store if singleton
        if (registration.singleton) {
          this.services.set(name, instance);
        }
      } else {
        throw new Error(`No valid factory found for service '${name}'`);
      }

      return instance;

    } catch (error) {
      console.error(`[ServiceContainer] ❌ Failed to create service '${name}':`, error);
      throw error;
    } finally {
      // Remove from initialization stack
      this.initializationStack.pop();
    }
  }

  /**
   * Get service if already instantiated (non-blocking)
   */
  getIfReady<T>(name: string): T | null {
    return this.services.get(name) || null;
  }

  /**
   * Check if service is registered (any type)
   */
  has(name: string): boolean {
    return this.factories.has(name) || this.lazyFactories.has(name) || this.serviceFactories.has(name);
  }

  /**
   * Resolve all dependencies for a service without instantiating the service itself
   * Useful for preparation phase of service initialization
   */
  async resolveDependencies(name: string): Promise<void> {
    const dependencies = this.dependencyGraph.get(name);
    if (!dependencies || dependencies.size === 0) {
      return; // No dependencies to resolve
    }

    // Pre-resolve all dependencies in parallel
    const dependencyPromises = Array.from(dependencies).map(depName => this.get(depName));
    await Promise.all(dependencyPromises);
  }

  /**
   * Check if service is instantiated
   */
  isReady(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Get all registered service names (all types)
   */
  getRegisteredServices(): string[] {
    return [
      ...Array.from(this.factories.keys()),
      ...Array.from(this.lazyFactories.keys()),
      ...Array.from(this.serviceFactories.keys())
    ];
  }

  /**
   * Get all instantiated service names
   */
  getReadyServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get service metadata (supports all service types)
   */
  getServiceMetadata(name: string): ServiceMetadata | null {
    const registration = this.factories.get(name);
    const lazyFactory = this.lazyFactories.get(name);
    const serviceFactory = this.serviceFactories.get(name);

    if (!registration && !lazyFactory && !serviceFactory) {
      return null;
    }

    // Find dependents (services that depend on this one)
    const dependents: string[] = [];
    for (const [serviceName, deps] of Array.from(this.dependencyGraph.entries())) {
      if (deps.has(name)) {
        dependents.push(serviceName);
      }
    }

    let singleton = true; // Default for lazy and service factory
    let dependencies: string[] = [];

    if (registration) {
      singleton = registration.singleton;
      dependencies = registration.dependencies || [];
    } else if (serviceFactory) {
      dependencies = serviceFactory.getRequiredDependencies();
    }
    // Lazy services have no explicit dependencies

    return {
      name,
      singleton,
      initialized: this.services.has(name),
      dependencies,
      dependents
    };
  }

  /**
   * Get all service metadata
   */
  getAllServiceMetadata(): Record<string, ServiceMetadata> {
    const metadata: Record<string, ServiceMetadata> = {};
    
    // Get metadata for all registered services (all types)
    for (const serviceName of this.getRegisteredServices()) {
      const meta = this.getServiceMetadata(serviceName);
      if (meta) {
        metadata[serviceName] = meta;
      }
    }

    return metadata;
  }

  async preInitialize(name: string): Promise<void> {
    try {
      await this.get(name);
    } catch (error) {
    }
  }

  /**
   * Pre-initialize multiple services in parallel
   */
  async preInitializeMany(names: string[]): Promise<void> {
    const promises = names.map(name => this.preInitialize(name));
    await Promise.allSettled(promises);
  }

  /**
   * Initialize services in dependency order
   */
  async initializeInOrder(names: string[]): Promise<void> {
    const sorted = this.topologicalSort(names);
    
    for (const name of sorted) {
      await this.get(name);
    }
  }

  /**
   * Validate dependency graph for cycles
   */
  validateDependencies(): { isValid: boolean; errors: string[] } {
    const cycles: string[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const detectCycle = (node: string, path: string[]): boolean => {
      if (recursionStack.has(node)) {
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart).join(' -> ') + ' -> ' + node;
        cycles.push(cycle);
        return true;
      }

      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      recursionStack.add(node);

      const dependencies = this.dependencyGraph.get(node) || new Set();
      for (const dep of Array.from(dependencies)) {
        if (detectCycle(dep, [...path, node])) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const service of Array.from(this.factories.keys())) {
      if (!visited.has(service)) {
        detectCycle(service, []);
      }
    }

    return {
      isValid: cycles.length === 0,
      errors: cycles
    };
  }

  /**
   * Topological sort for dependency order
   */
  private topologicalSort(services: string[]): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (node: string) => {
      if (visited.has(node)) return;
      visited.add(node);

      const dependencies = this.dependencyGraph.get(node) || new Set();
      for (const dep of Array.from(dependencies)) {
        if (services.includes(dep)) {
          visit(dep);
        }
      }

      result.push(node);
    };

    for (const service of services) {
      visit(service);
    }

    return result;
  }

  /**
   * Replace a service instance (for testing or hot-swapping)
   */
  replace<T>(name: string, instance: T): void {
    if (!this.factories.has(name)) {
      throw new Error(`Cannot replace unregistered service '${name}'`);
    }

    this.services.set(name, instance);
  }

  /**
   * Remove a service (cleanup)
   */
  remove(name: string): void {
    const instance = this.services.get(name);
    
    // Call cleanup if available
    if (instance && typeof instance.cleanup === 'function') {
      try {
        instance.cleanup();
      } catch (error) {
        console.error(`[ServiceContainer] Service '${name}' cleanup failed:`, error);
      }
    }

    // Remove from all maps
    this.services.delete(name);
    this.factories.delete(name);
    this.lazyFactories.delete(name);
    this.serviceFactories.delete(name);
    this.dependencyGraph.delete(name);
    this.pendingPromises.delete(name);
  }

  /**
   * Clear all services with proper cleanup
   */
  clear(): void {
    // Get services in reverse dependency order for cleanup
    const allServices = Array.from(this.services.keys());
    const cleanupOrder = this.topologicalSort(allServices).reverse();

    // Cleanup services in dependency order
    for (const serviceName of cleanupOrder) {
      const service = this.services.get(serviceName);
      
      if (service && typeof service.cleanup === 'function') {
        try {
          service.cleanup();
        } catch (error) {
          console.error(`[ServiceContainer] ❌ Cleanup failed for service '${serviceName}':`, error);
        }
      }
    }
    
    // Clear all maps
    this.services.clear();
    this.factories.clear();
    this.lazyFactories.clear();
    this.serviceFactories.clear();
    this.dependencyGraph.clear();
    this.pendingPromises.clear();
    this.initializationStack = [];
  }

  /**
   * Get container statistics
   */
  getStats(): { registered: number; ready: number; failed: number } {
    let singletons = 0;
    let transients = 0;
    let totalDependencies = 0;

    // Count regular factory services
    for (const registration of Array.from(this.factories.values())) {
      if (registration.singleton) {
        singletons++;
      } else {
        transients++;
      }
      totalDependencies += (registration.dependencies || []).length;
    }

    // Lazy services and factory services are always singletons
    singletons += this.lazyFactories.size + this.serviceFactories.size;

    // Count dependencies from service factories
    for (const factory of Array.from(this.serviceFactories.values())) {
      totalDependencies += factory.getRequiredDependencies().length;
    }

    return {
      registered: this.factories.size + this.lazyFactories.size + this.serviceFactories.size,
      ready: this.services.size,
      failed: 0 // TODO: Track failed services if needed
    };
  }

  /**
   * Export dependency graph for visualization
   */
  exportDependencyGraph(): { nodes: string[]; edges: Array<{ from: string; to: string }> } {
    const nodes = this.getRegisteredServices();
    const edges: Array<{ from: string; to: string }> = [];

    for (const [service, dependencies] of Array.from(this.dependencyGraph.entries())) {
      for (const dep of Array.from(dependencies)) {
        edges.push({ from: service, to: dep });
      }
    }

    return { nodes, edges };
  }
}