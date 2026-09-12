import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies, IRequestContext, SessionInfo, ToolExecutionResult } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { SessionContextManager } from '../../services/SessionContextManager';
import { isWorkspaceSelectionOnlyCommand } from '../../agents/toolManager/services/ToolCliNormalizer';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';

/** Callback type for tool response handling */
type ToolResponseCallback = (
    toolName: string,
    params: Record<string, unknown>,
    response: ToolExecutionResult,
    success: boolean,
    executionTime: number
) => Promise<void>;

/** Context structure within tool parameters */
interface ToolContext {
    sessionId?: string;
    workspaceId?: string;
    goal?: string;
    sessionDescription?: string;
    [key: string]: unknown;
}

/** Workspace context structure */
interface WorkspaceContext {
    workspaceId: string;
    workspacePath?: string[];
    contextDepth?: string;
}

/** Enhanced tool params with known properties */
interface EnhancedToolParams extends Record<string, unknown> {
    context?: ToolContext;
    sessionId?: string;
    workspaceContext?: WorkspaceContext;
}

interface ToolExecutionRequest {
    params: {
        name: string;
        arguments: Record<string, unknown>;
    };
    /** Attached by RequestHandlerFactory from the connection's initialize handshake. */
    clientName?: string;
}

/** The envelope fields processSession reads and rewrites. */
type SessionEnvelopeParams = Record<string, unknown> & {
    context?: { sessionId?: string; workspaceId?: string; [key: string]: unknown };
    sessionId?: string;
    workspaceId?: string;
    workspaceContext?: { workspaceId?: string; [key: string]: unknown };
};

/**
 * What processSession decided about the workspace, carried to bind point 1.
 * `handle` is the caller-supplied session id (friendly name or standard id) —
 * the key a later call will present again — not the internal id.
 */
interface WorkspaceBindingIntent {
    handle: string;
    displayHandle?: string;
    workspaceId: string;
    explicit: boolean;
    /**
     * What the handle was bound to BEFORE the tool ran. Bind point 1 compares
     * against this after execution: if the handle moved in between, bind point
     * 2 (`memory load-workspace` inside the batch) fired during the call and
     * must win — see bindWorkspaceFromResult.
     */
    priorBound?: string;
}

/**
 * What processSession decided about the CLI's current session, carried to
 * bind point 3. Present only when a CLI connection named a session
 * EXPLICITLY on this call; an inherited or defaulted handle is not a choice.
 */
interface CliSessionBindingIntent {
    handle: string;
}

/** Every session-related decision processSession hands back with the SessionInfo. */
interface SessionResolution {
    sessionInfo: SessionInfo;
    workspaceBinding?: WorkspaceBindingIntent;
    cliSessionBinding?: CliSessionBindingIntent;
}

type StrategyRequestContext = IRequestContext & {
    sessionInfo: SessionInfo;
    workspaceBinding?: WorkspaceBindingIntent;
    cliSessionBinding?: CliSessionBindingIntent;
};

/** Tool names on the two-tool surface, as the strategy sees them after the prefix split. */
const TOOL_MANAGER_AGENT = 'toolManager';
const USE_TOOLS = 'useTools';
const GET_TOOLS = 'getTools';

/**
 * The name the CLI sends as `clientInfo.name` on `initialize`
 * (cli/mcpLineClient.ts). Only connections that identify this way get the
 * current-session default and bind point 3; MCP clients and chat never do.
 */
export const CLI_CLIENT_NAME = 'nexus-cli';

/**
 * The handle a CLI call runs under when it names no session AND the vault has
 * never remembered one. The CLI used to fill this client-side; it is a
 * default, not a choice, and is never written to `cliCurrentSession`.
 */
export const CLI_DEFAULT_SESSION_HANDLE = 'nexus-cli';

interface ToolExecutionResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

export class ToolExecutionStrategy implements IRequestStrategy<ToolExecutionRequest, ToolExecutionResponse> {
    private readonly instanceId = `TES_V2_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    private readonly buildVersion = 'BUILD_20250803_1755'; // Force new instances

    constructor(
        private dependencies: IRequestHandlerDependencies,
        private getAgent: (name: string) => IAgent,
        private sessionContextManager?: SessionContextManager,
        private onToolResponse?: ToolResponseCallback
    ) {
        // ToolExecutionStrategy initialized with callback support
    }

    canHandle(request: ToolExecutionRequest): boolean {
        // Handle all tool execution requests
        // We'll validate the tool exists in handle() method
        return !!(request.params && request.params.name && request.params.arguments);
    }

    async handle(request: ToolExecutionRequest): Promise<ToolExecutionResponse> {
        const startTime = Date.now();
        let context: StrategyRequestContext | undefined;
        let success = false;
        let result: ToolExecutionResult;

        try {
            context = await this.buildRequestContext(request);
            const processedParams = await this.processParameters(context);
            result = await this.executeTool(context, processedParams);
            success = true;
            this.bindWorkspaceFromResult(context, result);
            this.bindCliSessionFromResult(context, result);

            // Trigger response capture callback if available
            if (this.onToolResponse) {
                try {
                    const executionTime = Date.now() - startTime;
                    await this.onToolResponse(
                        request.params.name,
                        context.params,
                        result,
                        success,
                        executionTime
                    );
                } catch {
                    // Silently ignore capture errors
                }
            }
            
            return this.dependencies.responseFormatter.formatToolExecutionResponse(
                result,
                context.sessionInfo,
                { tool: context.tool }
            );
        } catch (error) {
            // Trigger error response capture callback if available
            if (this.onToolResponse && context) {
                try {
                    const executionTime = Date.now() - startTime;
                    const errorResult: ToolExecutionResult = { success: false, error: (error as Error).message };
                    await this.onToolResponse(
                        request.params.name,
                        context.params,
                        errorResult,
                        false,
                        executionTime
                    );
                } catch {
                    // Silently ignore capture errors
                }
            }
            
            logger.systemError(error as Error, 'Tool Execution Strategy');
            
            // Build detailed error result object
            const errorMsg = (error as Error).message || 'Unknown error';
            let enhancedMessage = errorMsg;
            let parameterSchema: { required?: string[] } | null = null;

            // Add helpful hints for common parameter errors
            if (errorMsg.toLowerCase().includes('parameter') ||
                errorMsg.toLowerCase().includes('required') ||
                errorMsg.toLowerCase().includes('missing')) {
                enhancedMessage += '\n\n💡 Parameter Help: Check the tool schema for required parameters and their correct format.';

                // Try to get parameter schema for additional context
                if (context && context.agentName && context.tool) {
                    try {
                        const agent = this.getAgent(context.agentName);
                        const toolInstance = agent.getTool(context.tool);
                        if (toolInstance && typeof toolInstance.getParameterSchema === 'function') {
                            parameterSchema = toolInstance.getParameterSchema() as { required?: string[] };
                            if (parameterSchema && parameterSchema.required) {
                                enhancedMessage += `\n\n📋 Required Parameters: ${parameterSchema.required.join(', ')}`;
                            }
                        }
                    } catch {
                        // Ignore schema retrieval errors
                    }
                }
            }
            
            // Instead of throwing, return a formatted error response
            // This allows Claude Desktop to see the actual error message
            const errorResult = {
                success: false,
                error: enhancedMessage,
                providedParams: context?.params,
                expectedParams: parameterSchema?.required,
                suggestions: [
                    'Double-check all required parameters are provided',
                    'Ensure parameter names match the schema exactly',
                    'Check that parameter values are the correct type (string, array, object, etc.)'
                ]
            };
            
            return this.dependencies.responseFormatter.formatToolExecutionResponse(
                errorResult,
                context?.sessionInfo,
                { tool: context?.tool }
            );
        }
    }

    private async buildRequestContext(
        request: ToolExecutionRequest
    ): Promise<StrategyRequestContext> {
        const { name: fullToolName, arguments: parsedArgs } = request.params;

        if (!parsedArgs) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Missing arguments for tool ${fullToolName}\n\n💡 Provide the required parameters including "tool" to specify the operation.`
            );
        }

        // Two-Tool Architecture: Handle underscore format (toolManager_getTools, toolManager_useTool)
        // MCP requires tool names match ^[a-zA-Z0-9_-]{1,64}$ (no dots allowed)
        let agentName: string;
        let tool: string;
        let params: SessionEnvelopeParams;

        // Check if this is a toolManager tool (toolManager_getTools or toolManager_useTool)
        if (fullToolName.startsWith('toolManager_')) {
            // Two-tool architecture: "toolManager_getTools" → agent="toolManager", tool="getTools"
            agentName = 'toolManager';
            tool = fullToolName.substring('toolManager_'.length);
            params = { ...(parsedArgs as typeof params) };
        } else {
            // Legacy format: "contentManager_readContent" → agent="contentManager", tool from args
            agentName = this.extractAgentName(fullToolName);
            const { tool: toolFromArgs, ...restParams } = parsedArgs as { tool: string; [key: string]: unknown };
            tool = toolFromArgs;
            params = restParams;

            if (!tool) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `❌ Missing required parameter: tool for agent ${agentName}\n\n💡 Specify which tool to use.\n\nExample: { "tool": "directory", "query": "search term", ... }`
                );
            }
        }

        const { sessionInfo, workspaceBinding, cliSessionBinding } =
            await this.processSession(params, agentName, tool, request.clientName);

        const shouldInjectInstructions = this.dependencies.sessionService.shouldInjectInstructions(
            sessionInfo.sessionId,
            this.sessionContextManager
        );

        return {
            agentName,
            tool,
            params,
            sessionId: sessionInfo.sessionId,
            fullToolName,
            clientName: request.clientName,
            sessionContextManager: this.sessionContextManager,
            sessionInfo: {
                ...sessionInfo,
                shouldInjectInstructions
            },
            ...(workspaceBinding ? { workspaceBinding } : {}),
            ...(cliSessionBinding ? { cliSessionBinding } : {})
        };
    }

    /**
     * Resolve the session handle, then the workspace it runs in, then validate
     * the handle inside that workspace — in that order of dependency, because
     * the handle partition (`"<workspaceId>::<handle>"`) needs the workspace
     * and the workspace lookup needs the handle (#214):
     *
     *   sessionId:    explicit  →  cliCurrentSession ?? 'nexus-cli' (CLI connections only)  →  today's fallback
     *   workspaceId:  explicit  →  handle's last bind                                        →  UNBOUND
     *
     * The CLI default is applied only when the connection identified itself
     * as the CLI on `initialize` (`clientName === CLI_CLIENT_NAME`); MCP
     * clients and native chat behave exactly as before. Because the workspace
     * is looked up for the RESOLVED handle, an inherited CLI session inherits
     * its workspace too.
     *
     * UNBOUND is not an error here. `useTools` is left without a workspaceId so
     * ToolCliNormalizer.normalizeRequiredWorkspaceId throws its "pass it once"
     * steer; `getTools` is partitioned under 'default' so discovery can be a
     * session's first call — WITHOUT binding, because nothing was chosen. The
     * same partition-without-bind applies to a `useTools` batch made ONLY of
     * workspace-selection commands (see resolveUnboundPartition).
     *
     * The resolved canonical value is written back onto `params` so
     * normalizeContext and ToolBatchExecutionService.validateContext can stay
     * strict and unchanged. Mutates `params` in place, as the caller expects.
     */
    private async processSession(
        params: SessionEnvelopeParams,
        agentName: string,
        tool: string,
        clientName?: string
    ): Promise<SessionResolution> {
        const explicitSessionRaw = params.context?.sessionId || params.sessionId;
        const explicitSession = typeof explicitSessionRaw === 'string' && explicitSessionRaw.trim().length > 0
            ? explicitSessionRaw.trim()
            : undefined;
        const isCliConnection = clientName === CLI_CLIENT_NAME;

        let sessionId = explicitSession;
        if (!sessionId && isCliConnection && this.sessionContextManager) {
            // Continue where the CLI left off in this vault, or fall back to the
            // handle the CLI used to fill in client-side. Neither is a choice,
            // so neither is bound (see bindCliSessionFromResult).
            await this.sessionContextManager.ensureBindingsRestored();
            sessionId = this.sessionContextManager.getCliCurrentSession() ?? CLI_DEFAULT_SESSION_HANDLE;
        }

        if (!this.sessionContextManager || !sessionId) {
            // Fallback to original SessionService if no SessionContextManager or sessionId
            // processSessionId handles undefined by generating a new session ID
            const sessionInfo = await this.dependencies.sessionService.processSessionId(sessionId);
            if (params.context) {
                params.context.sessionId = sessionInfo.sessionId;
            }
            params.sessionId = sessionInfo.sessionId;
            return { sessionInfo };
        }

        const isToolManager = agentName === TOOL_MANAGER_AGENT;
        // Bind point 3 intent: only an EXPLICIT handle on a CLI connection is a
        // choice. Recorded before execution, acted on after (success gate).
        const cliSessionBinding: CliSessionBindingIntent | undefined =
            isCliConnection && explicitSession ? { handle: explicitSession } : undefined;
        let workspaceBinding: WorkspaceBindingIntent | undefined;
        try {
            // Legacy `agent_tool` calls carry the envelope under `context`; the
            // two-tool surface carries it at the top level (normalizeContext
            // rejects a nested `context` outright).
            const resolution = await this.sessionContextManager.resolveWorkspaceForSession(
                params.workspaceId ?? params.context?.workspaceId,
                sessionId
            );

            if (resolution.workspaceId) {
                // Two-tool calls read the top level; legacy calls read `context`.
                // A legacy call only gets the top-level key canonicalised if it
                // sent one — injecting a new key into an arbitrary tool's params
                // is not this method's business.
                if (isToolManager || !params.context || params.workspaceId !== undefined) {
                    params.workspaceId = resolution.workspaceId;
                }
                if (params.context) {
                    params.context.workspaceId = resolution.workspaceId;
                }
                workspaceBinding = {
                    handle: sessionId,
                    workspaceId: resolution.workspaceId,
                    explicit: resolution.explicit,
                    priorBound: this.sessionContextManager.resolveHandleWorkspace(sessionId)
                };
            }

            // UNBOUND: what runs anyway, and under which partition. Discovery
            // always does. So does a `useTools` batch made ENTIRELY of
            // `memory load-workspace` / `memory list-workspaces` /
            // `memory create-workspace` — the only exemption from the UNBOUND
            // rule. A fresh session has to be able to see its workspaces,
            // create one when none fits, and pick one; all three live behind
            // useTools, and the steer itself tells the caller to do exactly
            // this; without the exemption `load-workspace` would need the
            // workspace it is about to load. Creating is part of choosing and
            // is scoped to no workspace; the guidance says "create, then
            // load", so the load still binds. It is a partition, not a choice:
            // no WorkspaceBindingIntent is recorded, so bind point 1 stays
            // silent, and bind point 2 binds the workspace actually loaded on
            // success. A MIXED batch does not qualify: normalizeContext stamps
            // one workspaceId on the whole batch, so the trailing commands
            // would run under 'default' while the session was being bound
            // elsewhere — the misfiling #214 is about. It gets the steer.
            let unboundPartition: string | undefined;
            if (!resolution.workspaceId && isToolManager) {
                if (tool === GET_TOOLS) {
                    unboundPartition = 'default';
                } else if (tool === USE_TOOLS) {
                    if (isWorkspaceSelectionOnlyCommand(params.tool)) {
                        unboundPartition = 'default';
                        params.workspaceId = unboundPartition;
                    } else {
                        // Leave it absent. Deleting rather than skipping guards against a
                        // caller that sent `workspaceId: ""` — blank must fail exactly
                        // like omitted, not slip past `required` as a present key.
                        delete params.workspaceId;
                    }
                }
            }

            // For everything else unbound the manager's own 'default' parameter
            // applies, which is today's behaviour for legacy-format calls.
            const partitionWorkspace = resolution.workspaceId ?? unboundPartition;

            const validationResult = await this.sessionContextManager.validateSessionId(
                sessionId,
                typeof params.memory === 'string' ? params.memory : undefined,
                partitionWorkspace
            );
            const isNonStandardId = validationResult.displaySessionIdChanged;

            const sessionInfo: SessionInfo = {
                sessionId: validationResult.id,
                isNewSession: validationResult.created,
                isNonStandardId: isNonStandardId,
                originalSessionId: isNonStandardId ? sessionId : undefined,
                displaySessionId: validationResult.displaySessionId,
                displaySessionIdChanged: validationResult.displaySessionIdChanged
            };

            // Update params with validated session ID (both locations for compatibility)
            if (params.context) {
                params.context.sessionId = validationResult.id;
                params.context.sessionName = validationResult.displaySessionId;
            }
            params.sessionId = validationResult.id;
            params._displaySessionId = validationResult.displaySessionId;

            if (workspaceBinding && validationResult.displaySessionId !== sessionId) {
                workspaceBinding.displayHandle = validationResult.displaySessionId;
            }
            return { sessionInfo, workspaceBinding, cliSessionBinding };
        } catch (error) {
            logger.systemWarn(`SessionContextManager validation failed: ${getErrorMessage(error)}. Falling back to SessionService`);
            // Fallback to original SessionService if SessionContextManager fails
            const sessionInfo = await this.dependencies.sessionService.processSessionId(sessionId);
            if (params.context) {
                params.context.sessionId = sessionInfo.sessionId;
            }
            params.sessionId = sessionInfo.sessionId;
            // No bind of any kind on the fallback path: the manager that would hold it just failed.
            return { sessionInfo };
        }
    }

    /**
     * Bind point 3 (#214): an EXPLICIT `--session` on a CLI connection becomes
     * this vault's `cliCurrentSession` once the call succeeds, so the next CLI
     * call with no `--session` continues it. Same success rule as bind point 1
     * — for `useTools` the RESULT must not carry `success: false` (handle()'s
     * local flag is true for any non-throwing call); for `getTools` any
     * non-throwing result counts, since discovery has no failure payload of
     * its own. A thrown call never reaches here. The default and inherited
     * handles carry no intent and so are never bound.
     */
    private bindCliSessionFromResult(
        context: StrategyRequestContext,
        result: ToolExecutionResult
    ): void {
        const intent = context.cliSessionBinding;
        if (!this.sessionContextManager || !intent) {
            return;
        }
        if (context.agentName === TOOL_MANAGER_AGENT && context.tool === USE_TOOLS
            && (!result || result.success === false)) {
            return;
        }
        try {
            this.sessionContextManager.setCliCurrentSession(intent.handle);
        } catch (error) {
            logger.systemWarn(`CLI current-session bind failed for "${intent.handle}": ${getErrorMessage(error)}`);
        }
    }

    /**
     * Bind point 1 (#214): an EXPLICIT workspaceId on a `useTools` call whose
     * result did not fail binds the session's handle to that workspace.
     *
     * The check reads the RESULT, not `handle()`'s local `success` flag — that
     * flag is true for any non-throwing call, including one that returned
     * `{ success: false }` because validateWorkspaceId rejected the value. An
     * inherited workspace is not a new choice and never re-binds; `getTools`
     * never binds because discovery chooses nothing.
     *
     * Ordering with bind point 2: `nexus use --workspace X -- memory
     * load-workspace Y` fires BOTH points in one call — the batch service binds
     * Y while the tool runs, and this method runs after. The loaded workspace
     * is the more deliberate act and happened later, so it must win: if the
     * handle's binding moved since processSession snapshotted it, skip.
     */
    private bindWorkspaceFromResult(
        context: IRequestContext & { workspaceBinding?: WorkspaceBindingIntent },
        result: ToolExecutionResult
    ): void {
        const intent = context.workspaceBinding;
        if (!this.sessionContextManager || !intent || !intent.explicit) {
            return;
        }
        if (context.agentName !== TOOL_MANAGER_AGENT || context.tool !== USE_TOOLS) {
            return;
        }
        if (!result || result.success === false) {
            return;
        }
        try {
            if (this.boundDuringCall(intent.handle, intent.priorBound)) {
                return;
            }
            this.sessionContextManager.bindHandleWorkspace(intent.handle, intent.workspaceId);
            if (intent.displayHandle && intent.displayHandle !== intent.handle
                && !this.boundDuringCall(intent.displayHandle, intent.priorBound)) {
                this.sessionContextManager.bindHandleWorkspace(intent.displayHandle, intent.workspaceId);
            }
        } catch (error) {
            logger.systemWarn(`Workspace bind failed for session "${intent.handle}": ${getErrorMessage(error)}`);
        }
    }

    /**
     * True when `handle` is bound to something other than what processSession
     * saw before execution — i.e. bind point 2 moved it during this call. The
     * display handle (a renamed friendly id) had no binding of its own before
     * the call, so the same snapshot serves both: bind point 2 binds every
     * handle mapped to the session id at once.
     */
    private boundDuringCall(handle: string, priorBound: string | undefined): boolean {
        const current = this.sessionContextManager?.resolveHandleWorkspace(handle);
        if (current === undefined || current === priorBound) {
            return false;
        }
        logger.systemLog(
            `Session "${handle}" was bound to workspace ${current} during the call (load-workspace); keeping it over the explicit workspaceId`
        );
        return true;
    }

    private async processParameters(context: IRequestContext): Promise<EnhancedToolParams> {
        const agent = this.getAgent(context.agentName);
        const toolInstance = agent.getTool(context.tool);

        let paramSchema;
        try {
            if (toolInstance && typeof toolInstance.getParameterSchema === 'function') {
                paramSchema = toolInstance.getParameterSchema();
            }
        } catch (error) {
            logger.systemWarn(`Failed to get parameter schema for tool ${context.tool}: ${getErrorMessage(error)}`);
        }

        const validatedParams = await this.dependencies.validationService.validateToolParams(
            context.params,
            paramSchema,
            context.fullToolName
        );
        const enhancedParams = validatedParams as EnhancedToolParams;

        // Session validation is now handled in buildRequestContext() to avoid duplication.
        //
        // BEHAVIOR CHANGE (B4): the session description is no longer derived from
        // `context.goal`. Pre-B4 this branch read `context.goal || context.sessionDescription`;
        // that conflated the per-call objective with the long-lived session label and
        // caused the description to churn on every tool call. Under the B1/B4 contract
        // `goal` is request-scoped (workspaceId/sessionId/memory/goal/constraints are
        // top-level CLI fields) and is preserved on `params.context.goal` for
        // downstream tooling — it just does not overwrite the persistent session
        // description any more. Callers that previously sent only `goal` to update
        // the description must now send `sessionDescription` explicitly.
        const sessionGoal = enhancedParams.context?.sessionDescription;
        if (this.sessionContextManager &&
            enhancedParams.context?.sessionId &&
            sessionGoal) {
            try {
                // Safety check: ensure sessionId is not undefined
                const sessionIdToUpdate = enhancedParams.context.sessionId;
                if (sessionIdToUpdate && sessionIdToUpdate !== 'undefined') {
                    await this.sessionContextManager.updateSessionDescription(
                        sessionIdToUpdate,
                        sessionGoal
                    );
                } else {
                    logger.systemWarn(`Skipping session description update - sessionId is undefined or invalid`);
                }
            } catch (error) {
                logger.systemWarn(`Session description update failed: ${getErrorMessage(error)}`);
            }
        }

        let processedParams = { ...enhancedParams };
        if (this.sessionContextManager && processedParams.context?.sessionId) {
            // Check if we need to apply workspace context from session manager
            // Skip if we already have workspaceId in context or workspaceContext
            const hasWorkspaceId = processedParams.context?.workspaceId || 
                                   (processedParams.workspaceContext && processedParams.workspaceContext.workspaceId);
            
            if (!hasWorkspaceId) {
                processedParams = this.sessionContextManager.applyWorkspaceContext(
                    processedParams.context.sessionId, 
                    processedParams
                );
            }
            
            // If we have workspaceId in context but no workspaceContext, create one for backward compatibility
            if (processedParams.context?.workspaceId && !processedParams.workspaceContext) {
                processedParams.workspaceContext = {
                    workspaceId: processedParams.context.workspaceId,
                    workspacePath: [],
                    contextDepth: 'standard'
                };
            }
        }

        return processedParams;
    }

    private async executeTool(context: IRequestContext, processedParams: EnhancedToolParams): Promise<ToolExecutionResult> {
        const agent = this.getAgent(context.agentName);
        const result = await this.dependencies.toolExecutionService.executeAgent(
            agent,
            context.tool,
            processedParams
        );

        // Update session context from result (for load operations that return new workspace context)
        if (this.sessionContextManager && processedParams.sessionId && result.workspaceContext) {
            this.sessionContextManager.updateFromResult(processedParams.sessionId, result);
        }

        return result;
    }

    private extractAgentName(toolName: string): string {
        const lastUnderscoreIndex = toolName.lastIndexOf('_');
        return lastUnderscoreIndex === -1 ? toolName : toolName.substring(0, lastUnderscoreIndex);
    }
}
