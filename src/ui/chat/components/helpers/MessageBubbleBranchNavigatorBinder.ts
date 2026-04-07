import { Component } from 'obsidian';

import { ConversationMessage } from '../../../../types/chat/ChatTypes';
import { MessageBranchNavigator, MessageBranchNavigatorEvents } from '../MessageBranchNavigator';

interface MessageBubbleBranchNavigatorBinderDependencies {
  component?: Component;
  onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void;
}

export class MessageBubbleBranchNavigatorBinder {
  private branchNavigator: MessageBranchNavigator | null = null;
  private actionsContainer: HTMLElement | null = null;

  constructor(private readonly deps: MessageBubbleBranchNavigatorBinderDependencies) {}

  getNavigator(): MessageBranchNavigator | null {
    return this.branchNavigator;
  }

  sync(actions: HTMLElement | null, message: ConversationMessage): void {
    if (!actions || !message.branches || message.branches.length === 0) {
      this.destroy();
      return;
    }

    if (this.branchNavigator && this.actionsContainer !== actions) {
      this.destroy();
    }

    if (!this.branchNavigator) {
      this.actionsContainer = actions;
      this.branchNavigator = new MessageBranchNavigator(actions, this.createEvents(), this.deps.component);
    }

    this.branchNavigator.updateMessage(message);
  }

  destroy(): void {
    if (this.branchNavigator) {
      this.branchNavigator.destroy();
      this.branchNavigator = null;
    }

    this.actionsContainer = null;
  }

  private createEvents(): MessageBranchNavigatorEvents {
    return {
      onAlternativeChanged: (messageId, alternativeIndex) => {
        this.deps.onMessageAlternativeChanged?.(messageId, alternativeIndex);
      },
      onError: (message) => console.error('[MessageBubble] Branch navigation error:', message)
    };
  }
}
