import type { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';
import type { CompactionFrontierRecord } from '../../../services/chat/CompactionFrontierService';
import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import type { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import type { ModelOption } from '../types/SelectionTypes';
import type {
  ContextStatusInfo,
  LoadedWorkspaceData,
  SystemPromptBuilder,
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
}

interface ModelAgentPromptContextAssemblerDependencies {
  systemPromptBuilder: Pick<SystemPromptBuilder, 'build'>;
  getSessionId: () => Promise<string | undefined>;
}

export class ModelAgentPromptContextAssembler {
  constructor(private readonly deps: ModelAgentPromptContextAssemblerDependencies) {}

  async buildSystemPrompt(snapshot: ModelAgentPromptContextSnapshot): Promise<string | null> {
    const sessionId = await this.deps.getSessionId();

    return await this.deps.systemPromptBuilder.build({
      sessionId,
      workspaceId: snapshot.selectedWorkspaceId || undefined,
      contextNotes: snapshot.contextNotes,
      messageEnhancement: snapshot.messageEnhancement,
      customPrompt: snapshot.currentSystemPrompt,
      workspaceContext: snapshot.workspaceContext,
      loadedWorkspaceData: snapshot.loadedWorkspaceData as LoadedWorkspaceData | null,
      skipToolsSection: snapshot.selectedModel?.providerId === 'webllm',
      contextStatus: this.buildContextStatus(snapshot.contextTokenTracker),
      compactionFrontier: snapshot.compactionFrontier,
      legacyCompactionRecord: snapshot.latestCompactionRecord
    });
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
      temperature: snapshot.temperature
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
