import { IAgent } from '../../agents/interfaces/IAgent';
import { SessionContextManager } from '../../services/SessionContextManager';
import { ISchemaProvider, EnhancedJSONSchema } from './ISchemaProvider';
import { JSONSchema } from '../../types/schema/JSONSchemaTypes';

/**
 * Session information returned from session processing
 */
export interface SessionInfo {
    sessionId: string;
    isNewSession: boolean;
    isNonStandardId: boolean;
    originalSessionId?: string;
    shouldInjectInstructions?: boolean;
}

/**
 * MCP content response format
 */
export interface MCPContentResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

/**
 * Tool execution result from agents
 */
export interface ToolExecutionResult {
    success: boolean;
    data?: unknown;
    error?: string;
    [key: string]: unknown;
}

/**
 * Prompt argument definition
 */
export interface PromptArgument {
    name: string;
    description?: string;
    required?: boolean;
    type?: string;
}

/**
 * Tool definition for tool list
 */
export interface ToolDefinition {
    name: string;
    description?: string;
    inputSchema: JSONSchema | EnhancedJSONSchema;
}

/**
 * Agent schema for tool list
 */
export interface AgentSchema {
    name: string;
    description?: string;
    inputSchema: EnhancedJSONSchema;
    [key: string]: unknown;
}

/**
 * Prompt definition for prompts list
 */
export interface PromptDefinition {
    name: string;
    description?: string;
    arguments?: PromptArgument[];
}

/**
 * Batch operation structure
 */
export interface BatchOperation {
    type: string;
    params: Record<string, unknown>;
}

export interface IValidationService {
    validateToolParams(params: Record<string, unknown>, schema?: JSONSchema | EnhancedJSONSchema, toolName?: string): Promise<Record<string, unknown>>;
    validateSessionId(sessionId: string): Promise<string>;
    validateBatchOperations(operations: BatchOperation[]): Promise<void>;
    validateBatchPaths(paths: string[]): Promise<void>;
}

export interface ISessionService {
    processSessionId(sessionId: string | undefined): Promise<{
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
        params: Record<string, unknown>
    ): Promise<ToolExecutionResult>;
}


export interface IResponseFormatter {
    formatToolExecutionResponse(result: ToolExecutionResult, sessionInfo?: SessionInfo, context?: { tool?: string }): MCPContentResponse;
    formatSessionInstructions(sessionId: string, result: ToolExecutionResult): ToolExecutionResult;
    formatErrorResponse(error: Error): MCPContentResponse;
}

export interface IToolListService {
    generateToolList(
        agents: Map<string, IAgent>,
        isVaultEnabled: boolean,
        vaultName?: string
    ): Promise<{ tools: ToolDefinition[] }>;
    buildAgentSchema(agent: IAgent): AgentSchema;
    mergeToolSchemasIntoAgent(agent: IAgent, agentSchema: AgentSchema): AgentSchema;
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
    listPrompts(): Promise<{ prompts: PromptDefinition[] }>;
    listPromptsByCategory(category?: string): Promise<{ prompts: PromptDefinition[] }>;
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
    enhanceToolSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema>;
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