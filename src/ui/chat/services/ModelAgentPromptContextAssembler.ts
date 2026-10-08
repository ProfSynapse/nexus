import type { CliToolSchema } from '../../../agents/toolManager/types';
import type { PreparedWorkflow, PreparedInstruction, ServiceResult } from '../../../services/instructions/types';
import type { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';
import type { CompactionFrontierRecord } from '../../../services/chat/CompactionFrontierService';
import { shouldPassToolSchemasToProvider } from '../../../services/llm/utils/ToolSchemaSupport';
import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import type { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import type { ModelOption } from '../types/SelectionTypes';
import type {
  ContextStatusInfo,
  SystemPromptBuilder,
  ToolCatalogEntry,
  RemoteAgentPromptInfo,
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
  temperature: number;
  imageProvider: 'google' | 'openrouter' | 'openai';
  imageModel: string;
  transcriptionProvider: string | null;
  transcriptionModel: string | null;
  contextTokenTracker: ContextTokenTrackerLike | null;
  compactionFrontier: CompactionFrontierRecord[];
  latestCompactionRecord: CompactedContext | null;
}

export interface ModelAgentMessageOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
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
    if (preparedWorkflow && snapshot.selectedModel && (preparedWorkflow.estimatedTokens ?? Math.ceil(JSON.stringify(preparedWorkflow).length / 4)) > Math.max(0, snapshot.selectedModel.contextWindow - 2048)) {
      throw new Error('Selected workflow exceeds this model context budget. Choose a larger model or load a smaller workflow.');
    }
    const prompt = await this.deps.systemPromptBuilder.build({
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
    });
    if ((preparedWorkflow || individual.skills.length) && snapshot.selectedModel && Math.ceil((prompt?.length ?? 0) / 4) > Math.max(0, snapshot.selectedModel.contextWindow - (snapshot.contextTokenTracker?.getStatus().usedTokens ?? 0) - 2048)) {
      throw new Error('Loaded instructions and tools exceed this model context budget. Load fewer skills or choose a larger model.');
    }
    return prompt;
  }

  async buildMessageOptions(
    snapshot: ModelAgentPromptContextSnapshot
  ): Promise<ModelAgentMessageOptions> {
    const sessionId = await this.deps.getSessionId();

    return {
      provider: snapshot.selectedModel?.providerId,
      model: snapshot.selectedModel?.modelId,
      systemPrompt: await this.buildSystemPrompt(snapshot) || undefined,
      workspaceId: snapshot.selectedWorkspaceId || undefined,
      sessionId,
      enableThinking: snapshot.thinkingSettings.enabled,
      thinkingEffort: snapshot.thinkingSettings.effort,
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
