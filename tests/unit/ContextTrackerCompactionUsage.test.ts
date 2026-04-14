import { ContextTracker } from '../../src/ui/chat/services/ContextTracker';
import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

type ConversationManagerLike = {
  getCurrentConversation: jest.Mock<ConversationData, []>;
};

type ModelAgentManagerLike = {
  getSelectedModelOrDefault: jest.Mock<Promise<{ providerId: string; providerName: string; modelId: string; modelName: string; contextWindow: number }>, []>;
  getCurrentSystemPrompt: jest.Mock<Promise<string>, []>;
};

function createLongMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string
): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
    conversationId: 'conv_compaction_usage',
    state: 'complete'
  };
}

function createLargeConversation(): ConversationData {
  const messages: ConversationMessage[] = [];

  for (let i = 0; i < 8; i++) {
    messages.push(
      createLongMessage(
        `user_${i}`,
        'user',
        `Request ${i}: ${'Please preserve the exact context usage behavior after compaction. '.repeat(14)}`
      )
    );
    messages.push(
      createLongMessage(
        `assistant_${i}`,
        'assistant',
        `Response ${i}: ${'We should persist the frontier, rebuild the system prompt, and recompute usage from the reduced history. '.repeat(12)}`
      )
    );
  }

  return {
    id: 'conv_compaction_usage',
    title: 'Compaction usage regression',
    messages,
    created: Date.now(),
    updated: Date.now()
  };
}

describe('ContextTracker compaction usage regression', () => {
  it('recomputes a materially lower context usage after compaction', async () => {
    const builder = new SystemPromptBuilder(async () => '');
    const compactionService = new ContextCompactionService();
    const conversationBefore = createLargeConversation();

    const model = {
      providerId: 'anthropic-claude-code',
      providerName: 'Anthropic Claude Code',
      modelId: 'claude-sonnet-4-6',
      modelName: 'Claude Sonnet 4.6',
      contextWindow: 10000
    };

    const beforeSystemPrompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      availablePrompts: [],
      availableWorkspaces: [],
      toolAgents: []
    });

    const conversationManager = {
      getCurrentConversation: jest.fn().mockReturnValue(conversationBefore)
    };
    const modelAgentManager = {
      getSelectedModelOrDefault: jest.fn().mockResolvedValue(model),
      getCurrentSystemPrompt: jest.fn().mockResolvedValue(beforeSystemPrompt)
    };

    const tracker = new ContextTracker(
      conversationManager as ConversationManagerLike,
      modelAgentManager as ModelAgentManagerLike
    );

    const beforeUsage = await tracker.getContextUsage();

    const conversationAfter: ConversationData = {
      ...conversationBefore,
      messages: [...conversationBefore.messages]
    };

    const compactedContext = compactionService.compact(conversationAfter, {
      exchangesToKeep: 2,
      maxSummaryLength: 500,
      includeFileReferences: true
    });
    conversationAfter.metadata = {
      ...(conversationAfter.metadata ?? {}),
      compaction: {
        frontier: [compactedContext]
      }
    };

    const afterSystemPrompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      availablePrompts: [],
      availableWorkspaces: [],
      toolAgents: [],
      compactionFrontier: [compactedContext]
    });

    conversationManager.getCurrentConversation.mockReturnValue(conversationAfter);
    modelAgentManager.getCurrentSystemPrompt.mockResolvedValue(afterSystemPrompt);

    const afterUsage = await tracker.getContextUsage();

    expect(beforeUsage.used).toBeGreaterThan(afterUsage.used);
    expect(beforeUsage.percentage).toBeGreaterThan(afterUsage.percentage);
    expect(compactedContext.messagesRemoved).toBeGreaterThan(0);
    expect(afterUsage.used).toBeLessThan(beforeUsage.used * 0.8);
  });
});
