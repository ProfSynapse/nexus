/**
 * Location: src/core/ServiceFactory.ts
 *
 * Service factory definitions for standardized dependency injection
 * This file provides factory functions for creating agents with proper constructor injection
 * managed by the ServiceManager/ServiceContainer architecture.
 *
 * Key principles:
 * - All dependencies provided via constructor parameters
 * - ServiceManager resolves dependencies before agent creation
 * - No setter injection or manual service lookups
 * - Clear dependency declarations for each agent
 * - Type-safe dependency resolution
 *
 * Used by: AgentRegistrationService, ServiceManager
 * Dependencies: ServiceManager, all agent implementations
 */

import { App, Plugin } from 'obsidian';
import type { ServiceManager } from './ServiceManager';
import {
    ContentManagerAgent,
    CommandManagerAgent,
    VaultManagerAgent,
    VaultLibrarianAgent,
    MemoryManagerAgent,
    AgentManagerAgent
} from '../agents';
import { LLMProviderManager } from '../services/llm/providers/ProviderManager';
import { AgentManager } from '../services/AgentManager';
import { UsageTracker } from '../services/UsageTracker';
import { MemoryService } from '../agents/memoryManager/services/MemoryService';
import { Settings } from '../settings';

/**
 * Standardized agent factory interface
 */
export interface IAgentFactory<TAgent = any> {
    readonly name: string;
    readonly dependencies: string[];
    create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<TAgent>;
}

/**
 * Base agent factory with common dependency resolution
 */
abstract class BaseAgentFactory<TAgent> implements IAgentFactory<TAgent> {
    constructor(
        public readonly name: string,
        public readonly dependencies: string[]
    ) {}

    abstract create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<TAgent>;

    /**
     * Helper to safely get dependency from map
     */
    protected getDependency<T>(dependencies: Map<string, any>, name: string): T {
        const dependency = dependencies.get(name);
        if (!dependency) {
            throw new Error(`Required dependency '${name}' not found for agent '${this.name}'`);
        }
        return dependency;
    }

    /**
     * Helper to get optional dependency from map
     */
    protected getOptionalDependency<T>(dependencies: Map<string, any>, name: string): T | null {
        return dependencies.get(name) || null;
    }
}

/**
 * ContentManager agent factory with memory service dependencies
 */
export class ContentManagerAgentFactory extends BaseAgentFactory<ContentManagerAgent> {
    constructor() {
        super('contentManager', ['memoryService', 'workspaceService']); // Optional dependencies
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<ContentManagerAgent> {
        const memoryService = this.getOptionalDependency<MemoryService>(dependencies, 'memoryService');
        const workspaceService = this.getOptionalDependency<any>(dependencies, 'workspaceService');
        return new ContentManagerAgent(app, plugin as any, memoryService, workspaceService);
    }
}

/**
 * CommandManager agent factory - no external dependencies
 */
export class CommandManagerAgentFactory extends BaseAgentFactory<CommandManagerAgent> {
    constructor() {
        super('commandManager', []);
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<CommandManagerAgent> {
        return new CommandManagerAgent(app);
    }
}

/**
 * VaultManager agent factory - no external dependencies
 */
export class VaultManagerAgentFactory extends BaseAgentFactory<VaultManagerAgent> {
    constructor() {
        super('vaultManager', []); // No external dependencies
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<VaultManagerAgent> {
        return new VaultManagerAgent(app);
    }
}

/**
 * VaultLibrarian agent factory with memory service dependencies
 */
export class VaultLibrarianAgentFactory extends BaseAgentFactory<VaultLibrarianAgent> {
    constructor() {
        super('vaultLibrarian', ['memoryService', 'workspaceService']); // Optional dependencies
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<VaultLibrarianAgent> {
        // Get settings from plugin
        const pluginSettings = (plugin as any)?.settings?.settings;
        const enableSearchModes = false; // Currently disabled
        const memoryService = this.getOptionalDependency<MemoryService>(dependencies, 'memoryService');
        const workspaceService = this.getOptionalDependency<any>(dependencies, 'workspaceService');

        const agent = new VaultLibrarianAgent(app, enableSearchModes, memoryService, workspaceService);

        // Apply memory settings if available
        const memorySettings = pluginSettings?.memory;
        if (memorySettings) {
            agent.updateSettings(memorySettings);
        }

        return agent;
    }
}

/**
 * MemoryManager agent factory with memory service dependencies
 */
export class MemoryManagerAgentFactory extends BaseAgentFactory<MemoryManagerAgent> {
    constructor() {
        super('memoryManager', ['memoryService', 'workspaceService']); // Dependencies
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<MemoryManagerAgent> {
        const memoryService = this.getDependency<MemoryService>(dependencies, 'memoryService');
        const workspaceService = this.getDependency<any>(dependencies, 'workspaceService');
        return new MemoryManagerAgent(app, plugin, memoryService, workspaceService);
    }
}

/**
 * AgentManager agent factory with LLM provider dependencies
 */
export class AgentManagerAgentFactory extends BaseAgentFactory<AgentManagerAgent> {
    constructor() {
        super('agentManager', [
            'llmProviderManager',
            'agentManager',
            'usageTracker'
        ]);
    }

    async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<AgentManagerAgent> {
        // Get required dependencies
        const providerManager = this.getDependency<LLMProviderManager>(dependencies, 'llmProviderManager');
        const parentAgentManager = this.getDependency<AgentManager>(dependencies, 'agentManager');
        const usageTracker = this.getDependency<UsageTracker>(dependencies, 'usageTracker');

        // Get plugin settings
        const settings = (plugin as any).settings;
        if (!settings) {
            throw new Error('Plugin settings required for AgentManagerAgent');
        }

        // Create agent with all dependencies injected via constructor
        return new AgentManagerAgent(
            settings,
            providerManager,
            parentAgentManager,
            usageTracker,
            app.vault
        );
    }
}

/**
 * Registry of all agent factories
 */
export class AgentFactoryRegistry {
    private factories = new Map<string, IAgentFactory>();

    constructor() {
        // Register all agent factories
        this.registerFactory(new ContentManagerAgentFactory());
        this.registerFactory(new CommandManagerAgentFactory());
        this.registerFactory(new VaultManagerAgentFactory());
        this.registerFactory(new VaultLibrarianAgentFactory());
        this.registerFactory(new MemoryManagerAgentFactory());
        this.registerFactory(new AgentManagerAgentFactory());
    }

    private registerFactory(factory: IAgentFactory): void {
        this.factories.set(factory.name, factory);
    }

    getFactory(name: string): IAgentFactory | null {
        return this.factories.get(name) || null;
    }

    getAllFactories(): Map<string, IAgentFactory> {
        return new Map(this.factories);
    }

    /**
     * Get all dependencies for a specific agent
     */
    getDependencies(agentName: string): string[] {
        const factory = this.factories.get(agentName);
        return factory ? factory.dependencies : [];
    }

    /**
     * Get dependency graph for all agents
     */
    getDependencyGraph(): Map<string, string[]> {
        const graph = new Map<string, string[]>();

        for (const [name, factory] of this.factories) {
            graph.set(name, factory.dependencies);
        }

        return graph;
    }
}