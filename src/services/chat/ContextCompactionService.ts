/**
 * ContextCompactionService
 *
 * Handles automatic context compaction for token-limited models.
 * When context approaches the limit, this service:
 * 1. Extracts a summary from older messages
 * 2. Truncates old messages while preserving atomic units
 * 3. Returns summary for injection into system prompt as <previous_context>
 *
 * Design decisions:
 * - Fully programmatic (no LLM calls for summary)
 * - Preserves atomic message units (never splits user/assistant/tool sequences)
 * - Simple heuristic-based summary extraction
 * - Can be enhanced later to use createState tool for richer context
 */

import { ConversationMessage, ConversationData } from '../../types/chat/ChatTypes';

/**
 * Summary of compacted conversation context
 */
export interface CompactedContext {
  /** Human-readable summary of truncated conversation */
  summary: string;
  /** Number of messages removed */
  messagesRemoved: number;
  /** Number of messages kept */
  messagesKept: number;
  /** Files mentioned in truncated conversation */
  filesReferenced: string[];
  /** Key topics/tasks extracted from truncated portion */
  topics: string[];
  /** Timestamp of compaction */
  compactedAt: number;
}

/**
 * Options for compaction behavior
 */
export interface CompactionOptions {
  /** Number of complete exchanges to keep (default: 2) */
  exchangesToKeep?: number;
  /** Maximum length for extracted summary (default: 500 chars) */
  maxSummaryLength?: number;
  /** Include file references in summary (default: true) */
  includeFileReferences?: boolean;
}

const DEFAULT_OPTIONS: Required<CompactionOptions> = {
  exchangesToKeep: 2,
  maxSummaryLength: 500,
  includeFileReferences: true,
};

/**
 * Represents an atomic message unit that should not be split
 */
interface AtomicUnit {
  messages: ConversationMessage[];
  type: 'user' | 'assistant' | 'system';
  startIndex: number;
  endIndex: number;
}

export class ContextCompactionService {
  /**
   * Compact a conversation by extracting summary and truncating old messages
   *
   * @param conversation The conversation to compact (modified in place)
   * @param options Compaction options
   * @returns Summary of the compacted content
   */
  compact(
    conversation: ConversationData,
    options: CompactionOptions = {}
  ): CompactedContext {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const messages = conversation.messages;

    if (messages.length === 0) {
      return {
        summary: '',
        messagesRemoved: 0,
        messagesKept: 0,
        filesReferenced: [],
        topics: [],
        compactedAt: Date.now(),
      };
    }

    // 1. Identify atomic message units
    const units = this.identifyAtomicUnits(messages);

    // 2. Calculate how many units to keep (from the end)
    const unitsToKeep = Math.min(opts.exchangesToKeep * 2, units.length); // 2 units per exchange (user + assistant)
    const unitsToRemove = Math.max(0, units.length - unitsToKeep);

    if (unitsToRemove === 0) {
      return {
        summary: '',
        messagesRemoved: 0,
        messagesKept: messages.length,
        filesReferenced: [],
        topics: [],
        compactedAt: Date.now(),
      };
    }

    // 3. Get messages to remove (oldest units)
    const removedUnits = units.slice(0, unitsToRemove);
    const removedMessages: ConversationMessage[] = [];
    for (const unit of removedUnits) {
      removedMessages.push(...unit.messages);
    }

    // 4. Extract summary from removed messages
    const summary = this.extractSummary(removedMessages, opts);
    const filesReferenced = opts.includeFileReferences
      ? this.extractFileReferences(removedMessages)
      : [];
    const topics = this.extractTopics(removedMessages);

    // 5. Calculate kept messages
    const keptUnits = units.slice(unitsToRemove);
    const keptMessages: ConversationMessage[] = [];
    for (const unit of keptUnits) {
      keptMessages.push(...unit.messages);
    }

    // 6. Update conversation messages in place
    conversation.messages = keptMessages;

    return {
      summary,
      messagesRemoved: removedMessages.length,
      messagesKept: keptMessages.length,
      filesReferenced,
      topics,
      compactedAt: Date.now(),
    };
  }

  /**
   * Identify atomic message units that should not be split
   * - User message = 1 unit
   * - Assistant message (possibly with tool calls) = 1 unit
   * - System message = 1 unit
   */
  private identifyAtomicUnits(messages: ConversationMessage[]): AtomicUnit[] {
    const units: AtomicUnit[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'user') {
        units.push({
          messages: [msg],
          type: 'user',
          startIndex: i,
          endIndex: i,
        });
        i++;
      } else if (msg.role === 'assistant') {
        // Assistant message might have tool calls followed by tool results
        const unitMessages: ConversationMessage[] = [msg];
        let endIndex = i;

        // If this assistant message has tool calls, include subsequent tool results
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Look ahead for tool role messages
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') {
            unitMessages.push(messages[j]);
            endIndex = j;
            j++;
          }
        }

        units.push({
          messages: unitMessages,
          type: 'assistant',
          startIndex: i,
          endIndex,
        });
        i = endIndex + 1;
      } else if (msg.role === 'system') {
        units.push({
          messages: [msg],
          type: 'system',
          startIndex: i,
          endIndex: i,
        });
        i++;
      } else {
        // Tool messages should be included with their assistant message
        // If we encounter one standalone, include it as its own unit
        units.push({
          messages: [msg],
          type: 'assistant', // Treat as assistant unit
          startIndex: i,
          endIndex: i,
        });
        i++;
      }
    }

    return units;
  }

  /**
   * Extract a summary from removed messages
   */
  private extractSummary(
    messages: ConversationMessage[],
    opts: Required<CompactionOptions>
  ): string {
    if (messages.length === 0) return '';

    const parts: string[] = [];

    // Find the first user message to understand the initial request
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      const truncatedContent = this.truncateText(firstUserMsg.content, 150);
      parts.push(`Initial request: "${truncatedContent}"`);
    }

    // Find key tasks from assistant messages
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const tasks: string[] = [];

    for (const msg of assistantMessages) {
      // Extract task-like statements (simplified heuristic)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls
          .map((tc) => tc.function?.name || tc.name || 'tool')
          .slice(0, 3);
        tasks.push(`Used tools: ${toolNames.join(', ')}`);
      }
    }

    if (tasks.length > 0) {
      parts.push(`Activities: ${tasks.slice(0, 3).join('; ')}`);
    }

    // Find the last exchange to understand where we left off
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

    if (lastUserMsg && lastUserMsg !== firstUserMsg) {
      const truncatedContent = this.truncateText(lastUserMsg.content, 100);
      parts.push(`Last discussed: "${truncatedContent}"`);
    }

    if (lastAssistantMsg) {
      const truncatedContent = this.truncateText(lastAssistantMsg.content, 100);
      parts.push(`Assistant was: "${truncatedContent}"`);
    }

    const summary = parts.join(' | ');
    return this.truncateText(summary, opts.maxSummaryLength);
  }

  /**
   * Extract file references from messages (wikilinks and paths)
   */
  private extractFileReferences(messages: ConversationMessage[]): string[] {
    const files = new Set<string>();

    for (const msg of messages) {
      if (!msg.content) continue;

      // Match [[wikilinks]]
      const wikiLinks = msg.content.match(/\[\[([^\]]+)\]\]/g);
      if (wikiLinks) {
        for (const link of wikiLinks) {
          const name = link.slice(2, -2).split('|')[0]; // Handle [[link|alias]]
          files.add(name);
        }
      }

      // Match common file paths (simplified)
      const pathMatches = msg.content.match(/(?:^|[\s"'`])([a-zA-Z0-9_/-]+\.(?:md|txt|json|ts|js|py))/g);
      if (pathMatches) {
        for (const path of pathMatches) {
          files.add(path.trim());
        }
      }
    }

    return Array.from(files).slice(0, 10); // Limit to 10 files
  }

  /**
   * Extract key topics/tasks from messages (simple keyword extraction)
   */
  private extractTopics(messages: ConversationMessage[]): string[] {
    const topics = new Set<string>();

    for (const msg of messages) {
      if (msg.role !== 'user' || !msg.content) continue;

      // Look for task-like phrases
      const content = msg.content.toLowerCase();

      // Common task verbs
      const taskVerbs = ['create', 'write', 'update', 'fix', 'add', 'remove', 'edit', 'search', 'find', 'implement', 'refactor'];
      for (const verb of taskVerbs) {
        if (content.includes(verb)) {
          // Extract a short phrase after the verb
          const regex = new RegExp(`${verb}\\s+([a-zA-Z0-9\\s]{3,30})`, 'i');
          const match = msg.content.match(regex);
          if (match) {
            topics.add(`${verb} ${match[1].trim()}`.slice(0, 40));
          }
        }
      }
    }

    return Array.from(topics).slice(0, 5); // Limit to 5 topics
  }

  /**
   * Truncate text to max length, adding ellipsis if truncated
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3).trim() + '...';
  }

  /**
   * Check if compaction is recommended based on message count
   * (Supplement to token-based check in ContextTokenTracker)
   */
  shouldCompactByMessageCount(conversation: ConversationData, maxMessages: number = 20): boolean {
    return conversation.messages.length > maxMessages;
  }
}
