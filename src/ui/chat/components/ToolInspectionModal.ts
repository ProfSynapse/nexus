import { App, Component, Modal } from 'obsidian';
import type { ChatMessage, ToolCall } from '../../../types/chat/ChatTypes';
import type { PaginatedResult } from '../../../types/pagination/PaginationTypes';
import { formatToolStepLabel } from '../utils/toolDisplayFormatter';
import { getToolNameMetadata } from '../../../utils/toolNameUtils';

interface ToolInspectionHistorySource {
  getToolCallMessagesForConversation(
    conversationId: string,
    options?: { cursor?: string; pageSize?: number }
  ): Promise<PaginatedResult<ChatMessage>>;
}

interface ToolInspectionModalOptions {
  conversationId: string;
  historySource: ToolInspectionHistorySource;
  pageSize?: number;
}

type ToolInspectionMessage = ChatMessage & {
  sequenceNumber?: number;
};

type ToolCallState = 'pending' | 'complete' | 'failed';

const DEFAULT_PAGE_SIZE = 50;
const SCROLL_THRESHOLD_PX = 96;
const MAX_SERIALIZED_LENGTH = 8000;

export class ToolInspectionModal extends Modal {
  private readonly conversationId: string;
  private readonly historySource: ToolInspectionHistorySource;
  private readonly pageSize: number;

  private summaryEl!: HTMLDivElement;
  private scrollEl!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private loadingEl!: HTMLDivElement;
  private emptyEl!: HTMLDivElement;

  private loadedMessages: ToolInspectionMessage[] = [];
  private hasMorePages = false;
  private nextCursor: string | undefined;
  private isLoading = false;
  private isDisposed = false;
  private readonly component: Component;

  constructor(app: App, options: ToolInspectionModalOptions, component: Component) {
    super(app);
    this.conversationId = options.conversationId;
    this.historySource = options.historySource;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.component = component;
  }

  onOpen(): void {
    this.isDisposed = false;
    this.modalEl.addClass('tool-inspection-modal');
    this.contentEl.empty();
    this.contentEl.addClass('tool-inspection-modal__content');
    this.titleEl.setText('Tool history');

    const shellEl = this.contentEl.createDiv({ cls: 'tool-inspection-shell' });
    this.summaryEl = shellEl.createDiv({ cls: 'tool-inspection-summary' });
    this.scrollEl = shellEl.createDiv({ cls: 'tool-inspection-scroll' });
    this.listEl = this.scrollEl.createDiv({ cls: 'tool-inspection-list' });
    this.emptyEl = shellEl.createDiv({ cls: 'tool-inspection-empty' });
    this.loadingEl = shellEl.createDiv({ cls: 'tool-inspection-loading' });

    this.component.registerDomEvent(this.scrollEl, 'scroll', () => {
      if (this.scrollEl.scrollTop <= SCROLL_THRESHOLD_PX) {
        void this.loadPreviousPage();
      }
    });

    this.setLoadingState(true, 'Loading tool history...');
    void this.loadInitialPages();
  }

  onClose(): void {
    this.isDisposed = true;
    this.modalEl.removeClass('tool-inspection-modal');
    this.contentEl.empty();
  }

  private async loadInitialPages(): Promise<void> {
    this.isLoading = true;

    try {
      const firstPage = await this.historySource.getToolCallMessagesForConversation(this.conversationId, {
        pageSize: this.pageSize,
      });

      if (this.isDisposed) {
        return;
      }

      this.loadedMessages = this.mergeMessages(firstPage.items as ToolInspectionMessage[], []);
      this.hasMorePages = firstPage.hasNextPage;
      this.nextCursor = firstPage.nextCursor;
      this.renderMessages();

      requestAnimationFrame(() => {
        if (!this.isDisposed) {
          this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
        }
      });
    } catch {
      if (!this.isDisposed) {
        this.loadedMessages = [];
        this.emptyEl.setText('Unable to load tool history for this conversation.');
        this.emptyEl.removeClass('tool-inspection-empty-hidden');
        this.summaryEl.setText('Tool history is unavailable.');
      }
    } finally {
      this.isLoading = false;
      if (!this.isDisposed) {
        this.setLoadingState(false);
      }
    }
  }

  private async loadPreviousPage(): Promise<void> {
    if (this.isLoading || !this.hasMorePages || !this.nextCursor) {
      return;
    }

    this.isLoading = true;
    this.setLoadingState(true, 'Loading earlier tool activity...');

    const previousHeight = this.scrollEl.scrollHeight;

    try {
      const pageResult = await this.historySource.getToolCallMessagesForConversation(this.conversationId, {
        cursor: this.nextCursor,
        pageSize: this.pageSize,
      });

      if (this.isDisposed) {
        return;
      }

      this.loadedMessages = this.mergeMessages(pageResult.items as ToolInspectionMessage[], this.loadedMessages);
      this.hasMorePages = pageResult.hasNextPage;
      this.nextCursor = pageResult.nextCursor;
      this.renderMessages();

      requestAnimationFrame(() => {
        if (this.isDisposed) {
          return;
        }

        const newHeight = this.scrollEl.scrollHeight;
        this.scrollEl.scrollTop += newHeight - previousHeight;
      });
    } catch {
      if (!this.isDisposed) {
        this.summaryEl.setText('Unable to load older tool activity.');
      }
    } finally {
      this.isLoading = false;
      if (!this.isDisposed) {
        this.setLoadingState(false);
      }
    }
  }

  private renderMessages(): void {
    this.listEl.empty();

    const toolMessages = this.loadedMessages.filter((message) => Array.isArray(message.toolCalls) && message.toolCalls.length > 0);

    if (toolMessages.length === 0) {
      this.emptyEl.setText(this.hasMorePages
        ? 'No tool calls are loaded yet. Scroll up to inspect earlier activity.'
        : 'No tool calls were recorded for this conversation.');
      this.emptyEl.removeClass('tool-inspection-empty-hidden');
    } else {
      this.emptyEl.empty();
      this.emptyEl.addClass('tool-inspection-empty-hidden');

      for (const message of toolMessages) {
        this.renderMessageSection(message);
      }
    }

    this.updateSummary(toolMessages);
  }

  private renderMessageSection(message: ToolInspectionMessage): void {
    const sectionEl = this.listEl.createDiv({ cls: 'tool-inspection-message' });
    const headerEl = sectionEl.createDiv({ cls: 'tool-inspection-message-header' });

    const metaParts = [
      typeof message.sequenceNumber === 'number' ? `#${message.sequenceNumber}` : null,
      this.formatRole(message.role),
      this.formatTimestamp(message.timestamp),
    ].filter((value): value is string => value !== null);

    headerEl.createDiv({
      cls: 'tool-inspection-message-meta',
      text: metaParts.join(' · '),
    });

    const preview = this.getMessagePreview(message.content);
    if (preview) {
      headerEl.createDiv({
        cls: 'tool-inspection-message-preview',
        text: preview,
      });
    }

    const callsEl = sectionEl.createDiv({ cls: 'tool-inspection-calls' });
    for (const toolCall of message.toolCalls ?? []) {
      this.renderToolCallCard(callsEl, toolCall);
    }
  }

  private renderToolCallCard(container: HTMLElement, toolCall: ToolCall): void {
    const state = this.getToolCallState(toolCall);
    const parameters = this.getToolParameters(toolCall);
    const labelParameters = this.toRecordOrUndefined(parameters);
    const metadata = getToolNameMetadata(toolCall.technicalName ?? toolCall.name ?? toolCall.function.name);
    const summary = formatToolStepLabel(
      {
        technicalName: metadata.technicalName,
        parameters: labelParameters,
        result: toolCall.result,
        error: toolCall.error,
        status: state === 'failed' ? 'failed' : state === 'complete' ? 'completed' : 'executing',
      },
      state === 'failed' ? 'failed' : state === 'complete' ? 'past' : 'present'
    );

    const cardEl = container.createDiv({ cls: `tool-inspection-card tool-inspection-card--${state}` });
    const cardHeaderEl = cardEl.createDiv({ cls: 'tool-inspection-card-header' });
    const titleWrapEl = cardHeaderEl.createDiv({ cls: 'tool-inspection-card-title-wrap' });

    titleWrapEl.createDiv({
      cls: 'tool-inspection-card-title',
      text: metadata.displayName,
    });

    if (summary && summary !== metadata.displayName) {
      titleWrapEl.createDiv({
        cls: 'tool-inspection-card-summary',
        text: summary,
      });
    }

    cardHeaderEl.createDiv({
      cls: `tool-inspection-pill tool-inspection-pill--${state}`,
      text: this.getStateLabel(state),
    });

    if (metadata.technicalName) {
      cardEl.createDiv({
        cls: 'tool-inspection-card-technical',
        text: metadata.technicalName,
      });
    }

    if (toolCall.id) {
      cardEl.createDiv({
        cls: 'tool-inspection-card-id',
        text: `Call ID: ${toolCall.id}`,
      });
    }

    if (toolCall.error) {
      cardEl.createDiv({
        cls: 'tool-inspection-card-error',
        text: toolCall.error,
      });
    }

    const serializedParameters = this.serializeValue(parameters);
    if (serializedParameters) {
      this.renderDataBlock(cardEl, 'Parameters', serializedParameters);
    }

    const serializedResult = this.serializeValue(toolCall.result);
    if (serializedResult) {
      this.renderDataBlock(cardEl, 'Result', serializedResult, state !== 'pending');
    }
  }

  private renderDataBlock(parent: HTMLElement, label: string, content: string, open = false): void {
    const detailsEl = parent.createEl('details', { cls: 'tool-inspection-block' });
    detailsEl.open = open;
    detailsEl.createEl('summary', {
      cls: 'tool-inspection-block-summary',
      text: label,
    });
    detailsEl.createEl('pre', {
      cls: 'tool-inspection-code',
      text: content,
    });
  }

  private updateSummary(toolMessages: ToolInspectionMessage[]): void {
    const toolCallCount = toolMessages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0);
    if (toolCallCount === 0) {
      this.summaryEl.setText(this.hasMorePages
        ? 'No tool activity is visible yet. Scroll up to load earlier pages.'
        : 'No tool activity was recorded for this conversation.');
      return;
    }

    const callLabel = toolCallCount === 1 ? 'tool call' : 'tool calls';
    this.summaryEl.setText(this.hasMorePages
      ? `${toolCallCount} ${callLabel} loaded. Scroll up for earlier activity.`
      : `${toolCallCount} ${callLabel} in this conversation.`);
  }

  private setLoadingState(isLoading: boolean, message = 'Loading...'): void {
    if (isLoading) {
      this.loadingEl.setText(message);
      this.loadingEl.removeClass('tool-inspection-loading-hidden');
      return;
    }

    this.loadingEl.empty();
    this.loadingEl.addClass('tool-inspection-loading-hidden');
  }

  private mergeMessages(newMessages: ToolInspectionMessage[], existingMessages: ToolInspectionMessage[]): ToolInspectionMessage[] {
    const merged = new Map<string, ToolInspectionMessage>();

    for (const message of [...newMessages, ...existingMessages]) {
      merged.set(message.id, message);
    }

    return Array.from(merged.values()).sort((left, right) => {
      const leftSequence = typeof left.sequenceNumber === 'number' ? left.sequenceNumber : Number.MAX_SAFE_INTEGER;
      const rightSequence = typeof right.sequenceNumber === 'number' ? right.sequenceNumber : Number.MAX_SAFE_INTEGER;

      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }

      return left.timestamp - right.timestamp;
    });
  }

  private getToolCallState(toolCall: ToolCall): ToolCallState {
    if (toolCall.success === false || typeof toolCall.error === 'string') {
      return 'failed';
    }

    if (toolCall.result !== undefined || toolCall.success === true) {
      return 'complete';
    }

    return 'pending';
  }

  private getToolParameters(toolCall: ToolCall): unknown {
    if (toolCall.parameters !== undefined) {
      return toolCall.parameters;
    }

    if (!toolCall.function.arguments) {
      return undefined;
    }

    try {
      return JSON.parse(toolCall.function.arguments) as unknown;
    } catch {
      return toolCall.function.arguments;
    }
  }

  private toRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private getStateLabel(state: ToolCallState): string {
    switch (state) {
      case 'failed':
        return 'Failed';
      case 'complete':
        return 'Complete';
      default:
        return 'Pending';
    }
  }

  private serializeValue(value: unknown): string | null {
    if (value === undefined) {
      return null;
    }

    if (value === null) {
      return 'null';
    }

    if (typeof value === 'string') {
      return this.truncateSerialized(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return this.truncateSerialized(String(value));
    }

    try {
      return this.truncateSerialized(JSON.stringify(value, null, 2));
    } catch {
      if (value instanceof Error) {
        return this.truncateSerialized(value.message || value.name);
      }

      return this.truncateSerialized(Object.prototype.toString.call(value));
    }
  }

  private truncateSerialized(serialized: string): string {
    if (serialized.length <= MAX_SERIALIZED_LENGTH) {
      return serialized;
    }

    return `${serialized.slice(0, MAX_SERIALIZED_LENGTH)}\n... truncated`;
  }

  private getMessagePreview(content: string): string | null {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) {
      return null;
    }

    if (normalized.length <= 180) {
      return normalized;
    }

    return `${normalized.slice(0, 177)}...`;
  }

  private formatRole(role: ChatMessage['role']): string {
    switch (role) {
      case 'assistant':
        return 'Assistant';
      case 'system':
        return 'System';
      case 'tool':
        return 'Tool';
      default:
        return 'User';
    }
  }

  private formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}