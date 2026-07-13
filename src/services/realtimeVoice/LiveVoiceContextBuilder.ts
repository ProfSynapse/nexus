import type { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import { ContextBudgetService } from '../chat/ContextBudgetService';
import { ContextCompactionService, type CompactedContext } from '../chat/ContextCompactionService';

export interface LiveVoiceContextBuilderOptions {
  maxContextTokens?: number;
  maxMessageChars?: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 10_000;
const DEFAULT_MAX_MESSAGE_CHARS = 2_000;

export class LiveVoiceContextBuilder {
  constructor(private readonly options: LiveVoiceContextBuilderOptions = {}) {}

  build(conversation: ConversationData | null | undefined): string {
    if (!conversation || conversation.messages.length === 0) {
      return '';
    }

    const maxTokens = this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    const frontierSection = this.buildCompactionFrontierSection(conversation);
    const recentMessages = this.getVisibleRecentMessages(conversation);
    const recentSection = this.buildRecentMessagesSection(recentMessages);
    const context = this.wrapContext(frontierSection, recentSection);

    if (ContextBudgetService.estimateTextTokens(context) <= maxTokens) {
      return context;
    }

    return this.buildTrimmedContext(frontierSection, recentMessages, maxTokens);
  }

  private buildTrimmedContext(
    frontierSection: string,
    recentMessages: ConversationMessage[],
    maxTokens: number
  ): string {
    let trimmedMessages = [...recentMessages];

    while (trimmedMessages.length > 0) {
      const recentSection = this.buildRecentMessagesSection(trimmedMessages);
      const context = this.wrapContext(frontierSection, recentSection);
      if (ContextBudgetService.estimateTextTokens(context) <= maxTokens) {
        return context;
      }
      trimmedMessages = trimmedMessages.slice(1);
    }

    const frontierOnly = this.wrapContext(frontierSection, '');
    return ContextBudgetService.estimateTextTokens(frontierOnly) <= maxTokens
      ? frontierOnly
      : '';
  }

  private getVisibleRecentMessages(conversation: ConversationData): ConversationMessage[] {
    return ContextCompactionService
      .getMessagesAfterBoundary(conversation.messages, conversation.metadata)
      .filter(message => (
        !message.metadata?.hidden &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim().length > 0
      ));
  }

  private buildCompactionFrontierSection(conversation: ConversationData): string {
    const frontier = this.getCompactionFrontier(conversation);
    if (frontier.length === 0) {
      return '';
    }

    const records = frontier
      .filter(record => record.summary?.trim().length > 0)
      .map((record, index) => {
        const files = record.filesReferenced?.slice(0, 5) ?? [];
        const topics = record.topics?.slice(0, 8) ?? [];
        const lines = [
          `  <record index="${index}">`,
          `    <summary>${this.escapeXmlContent(record.summary)}</summary>`,
        ];
        if (files.length > 0) {
          lines.push(`    <files>${this.escapeXmlContent(files.join(', '))}</files>`);
        }
        if (topics.length > 0) {
          lines.push(`    <topics>${this.escapeXmlContent(topics.join(', '))}</topics>`);
        }
        lines.push('  </record>');
        return lines.join('\n');
      });

    if (records.length === 0) {
      return '';
    }

    return [
      '<compaction_context>',
      '<instruction>Compressed older conversation context. Use it for continuity, but rely on recent messages for current details.</instruction>',
      ...records,
      '</compaction_context>',
    ].join('\n');
  }

  private buildRecentMessagesSection(messages: ConversationMessage[]): string {
    if (messages.length === 0) {
      return '';
    }

    const maxMessageChars = this.options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    const renderedMessages = messages.map((message, index) => [
      `  <message index="${index}" role="${message.role}">`,
      this.escapeXmlContent(this.truncate(message.content, maxMessageChars)),
      '  </message>',
    ].join('\n'));

    return [
      '<recent_conversation>',
      ...renderedMessages,
      '</recent_conversation>',
    ].join('\n');
  }

  private wrapContext(frontierSection: string, recentSection: string): string {
    const sections = [frontierSection, recentSection].filter(section => section.trim().length > 0);
    if (sections.length === 0) {
      return '';
    }

    return [
      '<conversation_context>',
      '<instruction>This is prior text-chat context for the live voice session. Continue from it naturally; do not read or summarize this context unless asked.</instruction>',
      ...sections,
      '</conversation_context>',
    ].join('\n');
  }

  private getCompactionFrontier(conversation: ConversationData): CompactedContext[] {
    const metadataRecord = conversation.metadata;
    const compaction = metadataRecord?.compaction as { frontier?: CompactedContext[] } | undefined;
    return Array.isArray(compaction?.frontier) ? compaction.frontier : [];
  }

  private escapeXmlContent(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
}
