import { App } from 'obsidian';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IAgent } from '../agents/interfaces/IAgent';
import { SessionContextManager } from '../services/SessionContextManager';
import { IRequestHandlerDependencies } from './interfaces/IRequestHandlerServices';
import { IRequestStrategy } from './strategies/IRequestStrategy';

// Import services
import { ValidationService } from './services/ValidationService';
import { SessionService } from './services/SessionService';
import { ToolExecutionService } from './services/ToolExecutionService';
import { ResponseFormatter } from './services/ResponseFormatter';
import { ToolListService } from './services/ToolListService';
import { ResourceListService } from './services/ResourceListService';
import { ResourceReadService } from './services/ResourceReadService';
import { PromptsListService } from './services/PromptsListService';
import { CustomPromptStorageService } from "../agents/agentManager/services/CustomPromptStorageService";
import { ToolHelpService } from './services/ToolHelpService';
import { SchemaEnhancementService } from './services/SchemaEnhancementService';
import { VaultSchemaProvider } from './services/providers/VaultSchemaProvider';
import { WorkspaceSchemaProvider } from './services/providers/WorkspaceSchemaProvider';
import { AgentSchemaProvider } from './services/providers/AgentSchemaProvider';

// Import strategies
import { ToolExecutionStrategy } from './strategies/ToolExecutionStrategy';
import { ToolListStrategy } from './strategies/ToolListStrategy';
import { ResourceListStrategy } from './strategies/ResourceListStrategy';
import { ResourceReadStrategy } from './strategies/ResourceReadStrategy';
import { PromptsListStrategy } from './strategies/PromptsListStrategy';
import { PromptsGetStrategy } from './strategies/PromptsGetStrategy';
import { ToolHelpStrategy } from './strategies/ToolHelpStrategy';

// All requests now handled through modern strategy pattern

export class RequestRouter {
    private dependencies!: IRequestHandlerDependencies;
    private strategies: IRequestStrategy[] = [];

    constructor(
        private app: App,
        private agents: Map<string, IAgent>,
        private isVaultEnabled: boolean,
        private vaultName?: string,
        private sessionContextManager?: SessionContextManager,
        private customPromptStorage?: CustomPromptStorageService,
        private onToolResponse?: (toolName: string, params: any, response: any, success: boolean, executionTime: number) => Promise<void>
    ) {
        this.initializeDependencies();
        this.initializeStrategies();
    }

    private initializeDependencies(): void {
        const schemaEnhancementService = new SchemaEnhancementService();
        const toolListService = new ToolListService();
        
        // Register schema enhancement providers
        if (this.app) {
            const vaultSchemaProvider = new VaultSchemaProvider(this.app);
            schemaEnhancementService.registerProvider(vaultSchemaProvider);
        }
        
        // Register AgentSchemaProvider with access to agents and custom prompt storage
        const agentSchemaProvider = new AgentSchemaProvider();
        agentSchemaProvider.setAgentsMap(this.agents);
        if (this.customPromptStorage) {
            agentSchemaProvider.setCustomPromptStorage(this.customPromptStorage);
        }
        schemaEnhancementService.registerProvider(agentSchemaProvider);
        
        // Inject schema enhancement service into tool list service
        toolListService.setSchemaEnhancementService(schemaEnhancementService);
        
        this.dependencies = {
            validationService: new ValidationService(),
            sessionService: new SessionService(),
            toolExecutionService: new ToolExecutionService(),
            responseFormatter: new ResponseFormatter(),
            toolListService: toolListService,
            resourceListService: new ResourceListService(this.app),
            resourceReadService: new ResourceReadService(this.app),
            promptsListService: new PromptsListService(this.customPromptStorage),
            toolHelpService: new ToolHelpService(),
            schemaEnhancementService: schemaEnhancementService
        };
    }

    private initializeStrategies(): void {
        this.strategies = [
            new ToolListStrategy(
                this.dependencies,
                this.agents,
                this.isVaultEnabled,
                this.vaultName
            ),
            new ToolExecutionStrategy(
                this.dependencies,
                this.getAgent.bind(this),
                this.sessionContextManager,
                this.onToolResponse
            ),
            new ResourceListStrategy(
                this.dependencies,
                this.app
            ),
            new ResourceReadStrategy(
                this.dependencies,
                this.app
            ),
            new PromptsListStrategy(
                this.dependencies
            ),
            new PromptsGetStrategy(
                this.dependencies
            ),
            new ToolHelpStrategy(
                this.dependencies,
                this.getAgent.bind(this)
            )
        ];
    }

    async handleRequest(method: string, request: any): Promise<any> {
        // All requests now handled through strategy pattern
        const requestWithMethod = { method, ...request };
        return await this.handleWithStrategy(requestWithMethod);
    }

    private async handleWithStrategy(request: any): Promise<any> {
        for (const strategy of this.strategies) {
            if (strategy.canHandle(request)) {
                return await strategy.handle(request);
            }
        }
        
        throw new McpError(
            ErrorCode.MethodNotFound,
            `No strategy found for request: ${request.method || 'unknown'}`
        );
    }

    private getAgent(name: string): IAgent {
        const agent = this.agents.get(name);
        if (!agent) {
            // Build helpful error with suggestions
            const errorMessage = this.buildAgentNotFoundError(name);
            throw new McpError(
                ErrorCode.InvalidParams,
                errorMessage
            );
        }
        return agent;
    }

    /**
     * Build helpful error message when agent is not found
     * Suggests correct agent name if case is wrong, or lists available agents
     */
    private buildAgentNotFoundError(incorrectName: string): string {
        const lines: string[] = [];

        // Check for case-insensitive match
        const lowerName = incorrectName.toLowerCase();
        for (const agentName of this.agents.keys()) {
            if (agentName.toLowerCase() === lowerName) {
                lines.push(`Agent "${incorrectName}" not found.`);
                lines.push(`💡 Did you mean: ${agentName}?`);
                lines.push('');
                lines.push('Note: Agent names are case-sensitive.');
                return lines.join('\n');
            }
        }

        // List available agents
        const agentNames = Array.from(this.agents.keys());
        lines.push(`Agent "${incorrectName}" not found.`);
        lines.push('');
        lines.push('Available agents:');
        agentNames.forEach(name => lines.push(`  - ${name}`));

        return lines.join('\n');
    }

    // Expose dependencies for testing or extended functionality
    getDependencies(): IRequestHandlerDependencies {
        return this.dependencies;
    }

    // Allow adding custom strategies
    addStrategy(strategy: IRequestStrategy): void {
        this.strategies.push(strategy);
    }

    /**
     * Register WorkspaceSchemaProvider with the schema enhancement service
     * This is called after agents are initialized to ensure WorkspaceService is available
     */
    async registerWorkspaceSchemaProvider(): Promise<void> {
        try {
            // Get MemoryManager agent to access WorkspaceService
            const memoryManagerAgent = this.agents.get('memoryManager');
            if (!memoryManagerAgent) {
                return;
            }

            // Get WorkspaceService from MemoryManager agent
            const workspaceService = await (memoryManagerAgent as any).getWorkspaceServiceAsync();
            if (!workspaceService) {
                return;
            }

            // Create and register WorkspaceSchemaProvider
            const workspaceSchemaProvider = WorkspaceSchemaProvider.forMemoryManager(workspaceService);
            this.dependencies.schemaEnhancementService.registerProvider(workspaceSchemaProvider);
            
        } catch (error) {
        }
    }
}