import { ConversationMessage } from '../../../../types/chat/ChatTypes';

export interface MessageBubbleResolvedState {
  activeContent: string;
  activeToolCalls: ConversationMessage['toolCalls'] | undefined;
  activeReasoning: string | undefined;
  shouldRenderTextBubble: boolean;
}

export class MessageBubbleStateResolver {
  static resolve(message: ConversationMessage): MessageBubbleResolvedState {
    const activeContent = this.getActiveMessageContent(message);
    const activeToolCalls = this.getActiveToolCalls(message);
    const activeReasoning = this.getActiveReasoning(message);

    return {
      activeContent,
      activeToolCalls,
      activeReasoning,
      shouldRenderTextBubble: message.role === 'assistant' && (
        !!activeContent.trim() ||
        message.state === 'streaming' ||
        !!message.isLoading ||
        (activeToolCalls?.length ?? 0) > 0 ||
        !!activeReasoning
      )
    };
  }

  static getActiveMessageContent(message: ConversationMessage): string {
    const activeBranchMessage = this.getActiveBranchMessage(message);
    return activeBranchMessage?.content ?? message.content;
  }

  static getActiveToolCalls(message: ConversationMessage): ConversationMessage['toolCalls'] | undefined {
    const activeBranchMessage = this.getActiveBranchMessage(message);
    return activeBranchMessage?.toolCalls ?? message.toolCalls;
  }

  static getActiveReasoning(message: ConversationMessage): string | undefined {
    const activeBranchMessage = this.getActiveBranchMessage(message);
    return activeBranchMessage?.reasoning ?? message.reasoning;
  }

  private static getActiveBranchMessage(message: ConversationMessage): ConversationMessage | null {
    const activeIndex = message.activeAlternativeIndex || 0;
    if (activeIndex === 0 || !message.branches || message.branches.length === 0) {
      return null;
    }

    const branchIndex = activeIndex - 1;
    if (branchIndex < 0 || branchIndex >= message.branches.length) {
      return null;
    }

    const branch = message.branches[branchIndex];
    if (branch.messages.length === 0) {
      return null;
    }

    return branch.messages[branch.messages.length - 1];
  }
}
