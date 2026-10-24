import type { CliToolSchema } from '../../../agents/toolManager/types';
import type { PreparedWorkflow, PreparedInstruction, ServiceResult, ToolCatalogPort } from '../../../services/instructions/types';
import { selectPreviousToolSchemas, selectConversationRecoverySchema } from '../../../services/chat/CompactionToolContext';
import { selectCompactionTraceContext } from '../../../services/chat/CompactionTraceContext';
import type { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';
import type { CompactionFrontierRecord } from '../../../services/chat/CompactionFrontierService';
import { shouldPassToolSchemasToProvider } from '../../../services/llm/utils/ToolSchemaSupport';
import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { resolveThinkingForModel } from '../../../services/llm/utils/resolveThinkingForModel';
import type { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import type { ModelOption } from '../types/SelectionTypes';
import type {
  ContextStatusInfo,
  SystemPromptBuilder,
  ToolCatalogEntry,
  RemoteAgentPromptInfo,
  SystemPromptOptions,
} from './SystemPromptBuilder';

interface ContextTokenTrackerLike {
  getStatus(): {
    usedTokens: number;
    maxTokens: number;
    percentUsed: number;
    status: 'ok' | 'warning' | 'critical';
  };
  getStatusForPrompt(): string;
}

export interface ModelAgentPromptContextSnapshot {
  selectedModel: ModelOption | null;
  selectedWorkspaceId: string | null;
  workspaceContext: WorkspaceContext | null;
  loadedWorkspaceData: Record<string, unknown> | null;
  contextNotes: string[];
  messageEnhancement: MessageEnhancement | null;
  currentSystemPrompt: string | null;
  thinkingSettings: ThinkingSettings;
  webSearch: boolean;
  temperature: number;
  imageProvider: 'google' | 'openrouter' | 'openai';
  imageModel: string;
  transcriptionProvider: string | null;
  transcriptionModel: string | null;
  contextTokenTracker: ContextTokenTrackerLike | null;
  compactionFrontier: CompactionFrontierRecord[];
  latestCompactionRecord: CompactedContext | null;
  effectiveContextWindow?: number;
  compactionToolSelectors?: string[];
}

export interface ModelAgentMessageOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  enableThinking?: boolean;
  webSearch?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  temperature?: number;
  imageProvider?: 'google' | 'openrouter' | 'openai';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

interface ModelAgentPromptContextAssemblerDependencies {
  systemPromptBuilder: Pick<SystemPromptBuilder, 'build'>;
  getSessionId: () => Promise<string | undefined>;
  getRemoteAgents?: () => RemoteAgentPromptInfo[];
  getToolCatalog?: () => ToolCatalogEntry[];
  getToolCatalogService?: () => Promise<ToolCatalogPort | null>;
  restoreWorkflow?: (sessionId: string) => Promise<ServiceResult<PreparedWorkflow | null>>;
  prepareIndividualSkills?: (sessionId: string, workflow: PreparedWorkflow | null) => Promise<{ skills: PreparedInstruction[]; tools: CliToolSchema[] }>;
}

export class ModelAgentPromptContextAssembler {
  constructor(private readonly deps: ModelAgentPromptContextAssemblerDependencies) {}

  async buildSystemPrompt(snapshot: ModelAgentPromptContextSnapshot, workflowOverride?: PreparedWorkflow | null): Promise<string | null> {
    const sessionId = await this.deps.getSessionId();

    const restored = workflowOverride !== undefined ? { ok: true as const, value: workflowOverride } : sessionId && this.deps.restoreWorkflow ? await this.deps.restoreWorkflow(sessionId) : { ok: true as const, value: null };
    if (!restored.ok) throw new Error(`Selected workflow could not be restored: ${restored.error.message}`);
    const preparedWorkflow = restored.value;
    const individual = sessionId && this.deps.prepareIndividualSkills ? await this.deps.prepareIndividualSkills(sessionId, preparedWorkflow) : { skills: [], tools: [] };
    const effectiveWindow = snapshot.effectiveContextWindow ?? snapshot.selectedModel?.contextWindow ?? 0;
    if (preparedWorkflow && snapshot.selectedModel && (preparedWorkflow.estimatedTokens ?? Math.ceil(JSON.stringify(preparedWorkflow).length / 4)) > Math.max(0, effectiveWindow - 2048)) {
      throw new Error('Selected workflow exceeds this model context budget. Choose a larger model or load a smaller workflow.');
    }
    const promptOptions: SystemPromptOptions = {
      preparedWorkflow,
      activeSkills: individual.skills,
      preloadedTools: individual.tools,
      sessionId,
      workspaceId: snapshot.selectedWorkspaceId || undefined,
      contextNotes: snapshot.contextNotes,
      messageEnhancement: snapshot.messageEnhancement,
      customPrompt: snapshot.currentSystemPrompt,
      workspaceContext: snapshot.workspaceContext,
      loadedWorkspaceData: snapshot.loadedWorkspaceData,
      skipToolsSection: !shouldPassToolSchemasToProvider(snapshot.selectedModel?.providerId),
      contextStatus: this.buildContextStatus(snapshot.contextTokenTracker),
      compactionFrontier: snapshot.compactionFrontier,
      legacyCompactionRecord: snapshot.latestCompactionRecord,
      toolCatalog: this.deps.getToolCatalog?.(),
      remoteAgents: this.deps.getRemoteAgents?.(),
    };
    let prompt = await this.deps.systemPromptBuilder.build(promptOptions);
    const retainedReserve = snapshot.compactionFrontier.at(-1)?.retainedTokensAtCompaction ?? 0;
    const compacted = snapshot.compactionFrontier.length > 0 || !!snapshot.latestCompactionRecord;
    const selectors = snapshot.compactionToolSelectors
      ?? snapshot.compactionFrontier.flatMap(record => record.toolSelectors ?? []);
    const catalog = compacted || selectors.length ? await this.deps.getToolCatalogService?.() : null;
    // Recovery must be discoverable even if this conversation never used search.
    // Reserve the state and recent turns before allocating its full schema.
    if (compacted) {
      const recoveryBudget = Math.max(0, Math.floor(effectiveWindow * 0.75)
        - Math.ceil((prompt?.length ?? 0) / 4) - retainedReserve);
      const recovery = catalog ? selectConversationRecoverySchema(catalog, recoveryBudget,
        [...(preparedWorkflow?.preloadedTools ?? []), ...individual.tools])
        : { tools: [], deferred: ['search memory'] };
      promptOptions.preloadedTools = [...individual.tools, ...recovery.tools];
      promptOptions.deferredToolSelectors = recovery.deferred;
      prompt = await this.deps.systemPromptBuilder.build(promptOptions);
    }
    const traceContext = [...snapshot.compactionFrontier].reverse().find(record => record.traceContext)?.traceContext
      ?? snapshot.latestCompactionRecord?.traceContext;
    const traceBudget = Math.max(0, Math.min(Math.floor(effectiveWindow * 0.05),
      Math.floor(effectiveWindow * 0.75) - Math.ceil((prompt?.length ?? 0) / 4) - retainedReserve));
    promptOptions.recentTraceContext = selectCompactionTraceContext(traceContext, traceBudget);
    if (promptOptions.recentTraceContext) prompt = await this.deps.systemPromptBuilder.build(promptOptions);
    if (selectors.length) {
      const window = effectiveWindow;
      const stateReserve = snapshot.compactionFrontier.length ? 0 : Math.floor(window * 0.1);
      const budget = Math.max(0, Math.min(Math.floor(window * 0.15),
        Math.floor(window * 0.75) - Math.ceil((prompt?.length ?? 0) / 4) - stateReserve - retainedReserve));
      const selected = catalog ? selectPreviousToolSchemas(selectors, catalog, budget,
        [...(preparedWorkflow?.preloadedTools ?? []), ...(promptOptions.preloadedTools ?? [])])
        : { tools: [], deferred: [...new Set(selectors)] };
      prompt = await this.deps.systemPromptBuilder.build({ ...promptOptions,
        preloadedTools: [...(promptOptions.preloadedTools ?? []), ...selected.tools],
        deferredToolSelectors: [...new Set([...(promptOptions.deferredToolSelectors ?? []), ...selected.deferred])] });
    }
    if ((preparedWorkflow || individual.skills.length) && snapshot.selectedModel && Math.ceil((prompt?.length ?? 0) / 4) > Math.max(0, effectiveWindow - (snapshot.contextTokenTracker?.getStatus().usedTokens ?? 0) - 2048)) {
      throw new Error('Loaded instructions and tools exceed this model context budget. Load fewer skills or choose a larger model.');
    }
    return prompt;
  }

  async buildMessageOptions(
    snapshot: ModelAgentPromptContextSnapshot
  ): Promise<ModelAgentMessageOptions> {
    const sessionId = await this.deps.getSessionId();
    // The stored preference survives a switch to a non-reasoning model; it is
    // only the request that must not carry it.
    const thinking = resolveThinkingForModel(
      snapshot.selectedModel?.providerId,
      snapshot.selectedModel?.modelId,
      snapshot.thinkingSettings
    );

    return {
      provider: snapshot.selectedModel?.providerId,
      model: snapshot.selectedModel?.modelId,
      systemPrompt: await this.buildSystemPrompt(snapshot) || undefined,
      workspaceId: snapshot.selectedWorkspaceId || undefined,
      sessionId,
      enableThinking: thinking.enabled,
      webSearch: snapshot.webSearch && (
        ['anthropic', 'openai', 'openrouter'].includes(snapshot.selectedModel?.providerId || '')
        || (snapshot.selectedModel?.providerId === 'google'
          && snapshot.selectedModel.modelId.startsWith('gemini-3'))
      ),
      thinkingEffort: thinking.effort,
      temperature: snapshot.temperature,
      imageProvider: snapshot.imageProvider,
      imageModel: snapshot.imageModel,
      transcriptionProvider: snapshot.transcriptionProvider || undefined,
      transcriptionModel: snapshot.transcriptionModel || undefined
    };
  }

  private buildContextStatus(
    contextTokenTracker: ContextTokenTrackerLike | null
  ): ContextStatusInfo | null {
    if (!contextTokenTracker) {
      return null;
    }

    const status = contextTokenTracker.getStatus();
    return {
      usedTokens: status.usedTokens,
      maxTokens: status.maxTokens,
      percentUsed: status.percentUsed,
      status: status.status,
      statusMessage: contextTokenTracker.getStatusForPrompt()
    };
  }
}
