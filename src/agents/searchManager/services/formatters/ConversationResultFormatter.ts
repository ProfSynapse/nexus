/**
 * ConversationResultFormatter - Specialized formatter for conversation search results
 * Location: src/agents/searchManager/services/formatters/ConversationResultFormatter.ts
 *
 * Handles formatting of conversation QA pair results from semantic search.
 * Displays conversation-specific fields: title, Q/A content, matched side,
 * pair type, and optional windowed messages.
 *
 * Used by: ResultFormatter for CONVERSATION type results
 */

import {
  MemorySearchResult,
  EnrichedMemorySearchResult
} from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

/**
 * Helper to safely access conversation-specific fields from a MemorySearchResult.
 * The raw trace data is attached as _rawTrace on enriched results at runtime.
 */
function getConversationFields(result: MemorySearchResult): Record<string, unknown> {
  // At runtime, formatters always receive EnrichedMemorySearchResult which has _rawTrace.
  // Use a property check to safely access without unsafe casts.
  if ('_rawTrace' in result) {
    const rawTrace = (result as EnrichedMemorySearchResult)._rawTrace;
    if (rawTrace && typeof rawTrace === 'object') {
      return rawTrace as Record<string, unknown>;
    }
  }
  return {};
}

/**
 * Formatter for conversation search results (semantic QA pair matches)
 */
export class ConversationResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    const fields = getConversationFields(result);
    const conversationTitle = fields.conversationTitle ?? 'Untitled';
    return `Conversation: ${String(conversationTitle)}`;
  }

  protected generateSubtitle(result: MemorySearchResult): string | undefined {
    const fields = getConversationFields(result);
    const parts: string[] = [];

    if (fields.pairType) {
      parts.push(fields.pairType === 'trace_pair' ? 'Tool Trace' : 'QA Turn');
    }

    if (fields.matchedSide) {
      parts.push(`Matched: ${String(fields.matchedSide)}`);
    }

    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: Record<string, unknown>): void {
    if (metadata.conversationId) {
      formatted['Conversation ID'] = String(metadata.conversationId);
    }

    if (metadata.pairType) {
      formatted['Pair Type'] = String(metadata.pairType);
    }

    if (metadata.matchedSide) {
      formatted['Matched Side'] = String(metadata.matchedSide);
    }
  }
}
