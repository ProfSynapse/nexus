import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';

interface ConversationCompactionMetadata {
  previousContext?: CompactedContext;
  frontier?: CompactedContext[];
}

export interface ConversationSettingsMetadata {
  providerId?: string;
  modelId?: string;
  promptId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  contextNotes?: string[];
  thinking?: ThinkingSettings;
  temperature?: number;
  agentProvider?: string | null;
  agentModel?: string | null;
  agentThinking?: ThinkingSettings;
  imageProvider?: 'google' | 'openrouter';
  imageModel?: string;
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

  async getSessionId(conversationId: string): Promise<string | undefined> {
    if (!this.conversationService) {
      return undefined;
    }

    const conversation = await this.conversationService.getConversation(conversationId);
    return conversation?.metadata?.chatSettings?.sessionId ?? undefined;
  }
}
