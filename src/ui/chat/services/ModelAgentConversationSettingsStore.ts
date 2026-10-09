import type {
  DefaultRealtimeVoiceModelSettings,
  DefaultSpeechModelSettings,
  ThinkingSettings
} from '../../../types/llm/ProviderTypes';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';

interface ConversationCompactionMetadata {
  previousContext?: CompactedContext;
  frontier?: CompactedContext[];
}

export interface ConversationSettingsMetadata {
  providerId?: string;
  modelId?: string;
  /** Committed budget for this conversation, independent of later global defaults. */
  effectiveContextWindow?: number;
  promptId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  contextNotes?: string[];
  thinking?: ThinkingSettings;
  webSearch?: boolean;
  temperature?: number;
  agentProvider?: string | null;
  agentModel?: string | null;
  agentThinking?: ThinkingSettings;
  imageProvider?: 'google' | 'openrouter' | 'openai';
  imageModel?: string;
  speechProvider?: DefaultSpeechModelSettings['provider'] | null;
  speechModel?: DefaultSpeechModelSettings['model'] | null;
  speechVoice?: DefaultSpeechModelSettings['voice'] | null;
  realtimeVoiceProvider?: DefaultRealtimeVoiceModelSettings['provider'] | null;
  realtimeVoiceModel?: DefaultRealtimeVoiceModelSettings['model'] | null;
  realtimeVoiceVoice?: DefaultRealtimeVoiceModelSettings['voice'] | null;
  transcriptionProvider?: string | null;
  transcriptionModel?: string | null;
}

export interface ConversationMetadataWithCompaction {
  chatSettings?: ConversationSettingsMetadata;
  compaction?: ConversationCompactionMetadata;
  [key: string]: unknown;
}

export interface ConversationServiceLike {
  getConversation(conversationId: string, pagination?: { page?: number; pageSize?: number }): Promise<{
    metadata?: ConversationMetadataWithCompaction;
  } | null>;
  updateConversationMetadata(conversationId: string, metadata: Record<string, unknown>): Promise<void>;
}

export class ContextHandoffRecoveryError extends Error {
  constructor(public readonly originalError: unknown, public readonly recoveryError: unknown) {
    super('Context save could not be recovered; reload this chat before sending');
    this.name = 'ContextHandoffRecoveryError';
  }
}

export class ModelAgentConversationSettingsStore {
  constructor(private readonly conversationService?: ConversationServiceLike) {}

  async load(conversationId: string): Promise<{
    conversationMetadata: ConversationMetadataWithCompaction | undefined;
    chatSettings: ConversationSettingsMetadata | undefined;
  }> {
    if (!this.conversationService) {
      return {
        conversationMetadata: undefined,
        chatSettings: undefined
      };
    }

    const conversation = await this.conversationService.getConversation(conversationId);
    const conversationMetadata = conversation?.metadata;

    return {
      conversationMetadata,
      chatSettings: conversationMetadata?.chatSettings
    };
  }

  async save(
    conversationId: string,
    chatSettings: ConversationSettingsMetadata
  ): Promise<void> {
    if (!this.conversationService) {
      return;
    }

    const existingConversation = await this.conversationService.getConversation(conversationId);
    const existingSessionId = existingConversation?.metadata?.chatSettings?.sessionId;

    await this.conversationService.updateConversationMetadata(conversationId, {
      chatSettings: {
        ...chatSettings,
        sessionId: existingSessionId ?? chatSettings.sessionId
      }
    });
  }

  /** Commit a model/window handoff and its frontier in one durable metadata update. */
  async commitHandoff(
    conversationId: string,
    chatSettings: ConversationSettingsMetadata,
    frontier: CompactedContext[],
    sourceSettings?: ConversationSettingsMetadata
  ): Promise<ConversationMetadataWithCompaction> {
    if (!this.conversationService) throw new Error('Conversation persistence is unavailable');
    const conversation = await this.conversationService.getConversation(conversationId);
    if (!conversation) throw new Error('Conversation no longer exists');
    const metadata = conversation.metadata ?? {};
    const { previousContext: _legacyPreviousContext, ...remainingCompaction } = metadata.compaction ?? {};
    void _legacyPreviousContext;
    const committed: ConversationMetadataWithCompaction = {
      ...metadata,
      chatSettings: {
        ...metadata.chatSettings,
        ...chatSettings,
        sessionId: metadata.chatSettings?.sessionId ?? chatSettings.sessionId
      },
      compaction: {
        ...remainingCompaction,
        frontier
      }
    };
    try {
      await this.conversationService.updateConversationMetadata(conversationId, committed);
    } catch (error) {
      // The repository appends its JSONL event before updating SQLite. A cache
      // failure can therefore leave a durable target event despite rejection.
      // Append a compensating event through the same repository path.
      let latestMetadata = metadata;
      try {
        latestMetadata = (await this.conversationService.getConversation(conversationId))?.metadata ?? metadata;
      } catch {
        // A failed cache read does not prevent trying the event-store rollback.
      }
      const rollback: ConversationMetadataWithCompaction = {
        ...latestMetadata,
        chatSettings: {
          ...latestMetadata.chatSettings,
          providerId: metadata.chatSettings?.providerId ?? sourceSettings?.providerId,
          modelId: metadata.chatSettings?.modelId ?? sourceSettings?.modelId,
          effectiveContextWindow: metadata.chatSettings?.effectiveContextWindow ?? sourceSettings?.effectiveContextWindow
        },
        compaction: metadata.compaction ?? { frontier: [] }
      };
      try {
        await this.conversationService.updateConversationMetadata(conversationId, rollback);
      } catch (recoveryError) {
        throw new ContextHandoffRecoveryError(error, recoveryError);
      }
      throw error;
    }
    return committed;
  }

  async getSessionId(conversationId: string): Promise<string | undefined> {
    if (!this.conversationService) {
      return undefined;
    }

    const conversation = await this.conversationService.getConversation(conversationId);
    return conversation?.metadata?.chatSettings?.sessionId ?? undefined;
  }
}
