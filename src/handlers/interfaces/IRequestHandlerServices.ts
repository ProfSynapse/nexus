import { IAgent } from '../../agents/interfaces/IAgent';
import { SessionContextManager } from '../../services/SessionContextManager';
import { ISchemaProvider } from './ISchemaProvider';

export interface IValidationService {
    validateToolParams(params: any, schema?: any, toolName?: string): Promise<any>;
    validateSessionId(sessionId: string): Promise<string>;
    validateBatchOperations(operations: any[]): Promise<void>;
    validateBatchPaths(paths: any[]): Promise<void>;
}

export interface ISessionService {
    processSessionId(sessionId: string): Promise<{
        sessionId: string;
        isNewSession: boolean;
        isNonStandardId: boolean;
        originalSessionId?: string;
    }>;
    generateSessionId(): string;
    isStandardSessionId(sessionId: string): boolean;
    shouldInjectInstructions(sessionId: string, sessionContextManager?: SessionContextManager): boolean;
}

export interface IToolExecutionService {
    executeAgent(
        agent: IAgent,
        tool: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params: any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any>;
}


export interface IResponseFormatter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatToolExecutionResponse(result: any, sessionInfo?: any, context?: { tool?: string }): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatSessionInstructions(sessionId: string, result: any): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatErrorResponse(error: Error): any;
}

export interface IToolListService {
    generateToolList(
        agents: Map<string, IAgent>,
        isVaultEnabled: boolean,
        vaultName?: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<{ tools: any[] }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildAgentSchema(agent: IAgent): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mergeToolSchemasIntoAgent(agent: IAgent, agentSchema: any): any;
    setSchemaEnhancementService(service: ISchemaEnhancementService): void;
}

export interface IResourceListService {
    listResources(): Promise<{ resources: Array<{ uri: string; name: string; mimeType: string }> }>;
    listResourcesByPath(pathPrefix?: string): Promise<{ resources: Array<{ uri: string; name: string; mimeType: string }> }>;
}

export interface IResourceReadService {
    readResource(uri: string): Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>;
    readMultipleResources(uris: string[]): Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>;
    resourceExists(uri: string): Promise<boolean>;
}

export interface IPromptsListService {
    listPrompts(): Promise<{ prompts: Array<{ name: string; description?: string; arguments?: any[] }> }>;
    listPromptsByCategory(category?: string): Promise<{ prompts: Array<{ name: string; description?: string; arguments?: any[] }> }>;
    promptExists(name: string): Promise<boolean>;
    getPrompt(name: string): Promise<string | null>;
}

export interface IToolHelpService {
    generateToolHelp(
        getAgent: (name: string) => IAgent,
        toolName: string,
        toolSlug: string
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
    generateAgentHelp(
        getAgent: (name: string) => IAgent,
        toolName: string
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
    validateToolExists(
        getAgent: (name: string) => IAgent,
        toolName: string,
        toolSlug: string
    ): Promise<boolean>;
}

export interface IRequestContext {
    agentName: string;
    tool: string;
    params: Record<string, unknown>;
    sessionId: string;
    fullToolName: string;
    sessionContextManager?: SessionContextManager;
}

export interface ISchemaEnhancementService {
    enhanceToolSchema(toolName: string, baseSchema: any): Promise<any>;
    getAvailableEnhancements(): Promise<string[]>;
    registerProvider(provider: ISchemaProvider): void;
    unregisterProvider(providerName: string): boolean;
    hasProvider(providerName: string): boolean;
    clearProviders(): void;
    getProviderInfo(): Array<{ name: string; description: string; priority: number }>;
}

export interface IRequestHandlerDependencies {
    validationService: IValidationService;
    sessionService: ISessionService;
    toolExecutionService: IToolExecutionService;
    responseFormatter: IResponseFormatter;
    toolListService: IToolListService;
    resourceListService: IResourceListService;
    resourceReadService: IResourceReadService;
    promptsListService: IPromptsListService;
    toolHelpService: IToolHelpService;
    schemaEnhancementService: ISchemaEnhancementService;
}