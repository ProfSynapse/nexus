// Location: src/services/helpers/ConversationTypeConverters.ts
// Type conversion helpers between HybridStorageTypes and legacy StorageTypes for conversations.
// Extracted from ConversationService to reduce file size and isolate conversion logic.
// Used by: ConversationService

import { IndividualConversation, ConversationMetadata as LegacyConversationMetadata, ConversationMessage } from '../../types/storage/StorageTypes';
import { ConversationMetadata, MessageData } from '../../types/storage/HybridStorageTypes';
import type { ConversationBranch, SubagentBranchMetadata, HumanBranchMetadata } from '../../types/branch/BranchTypes';
import type { ToolCall as ChatToolCall } from '../../types/chat/ChatTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseToolArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'string') {
    return argumentsValue;
  }

  try {
    return JSON.parse(argumentsValue) as unknown;
  } catch {
    return argumentsValue;
  }
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getRunTriggerValue(value: unknown): 'manual' | 'scheduled' | 'catch_up' | undefined {
  return value === 'manual' || value === 'scheduled' || value === 'catch_up'
    ? value
    : undefined;
}

/**
 * Convert new ConversationMetadata to legacy format
 */
export function convertToLegacyMetadata(metadata: ConversationMetadata): LegacyConversationMetadata {
  return {
    id: metadata.id,
    title: metadata.title,
    created: metadata.created,
    updated: metadata.updated,
    vault_name: metadata.vaultName,
    message_count: metadata.messageCount
  };
}

/**
 * Convert a branch conversation to embedded ConversationBranch format
 * Used for UI compatibility with message.branches[]
 */
export function convertToConversationBranch(branchConversation: IndividualConversation): ConversationBranch {
  const meta = branchConversation.metadata || {};
  const branchType = meta.branchType === 'subagent' ? 'subagent' : 'human';

  // Extract subagent-specific metadata if present
  const subagentMeta = meta.subagent as SubagentBranchMetadata | undefined;

  return {
    id: branchConversation.id,
    type: branchType,
    inheritContext: meta.inheritContext ?? (branchType === 'human'),
    messages: branchConversation.messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      conversationId: branchConversation.id,
      state: m.state,
      toolCalls: m.toolCalls as unknown as ChatToolCall[] | undefined, // Storage ToolCall type differs only in narrower type field
      reasoning: m.reasoning,
    })),
    created: branchConversation.created,
    updated: branchConversation.updated,
    metadata: branchType === 'subagent' && subagentMeta
      ? subagentMeta
      : { description: branchConversation.title } as HumanBranchMetadata,
  };
}

/**
 * Convert new ConversationMetadata + MessageData[] to legacy IndividualConversation
 */
export function convertToLegacyConversation(
  metadata: ConversationMetadata,
  messages: MessageData[]
): IndividualConversation {
  // Type assertion for metadata - structure matches IndividualConversation.metadata
  const meta = (metadata.metadata || {}) as IndividualConversation['metadata'] & Record<string, unknown>;
  const chatSettings = isRecord(meta.chatSettings) ? meta.chatSettings : undefined;
  const metaCost = meta?.cost;
  const metaTotalCost = meta?.totalCost;
  const metaCurrency = meta?.currency;
  const resolvedCost = metaCost || (metaTotalCost !== undefined ? { totalCost: metaTotalCost, currency: metaCurrency || 'USD' } : undefined);
  return {
    id: metadata.id,
    title: metadata.title,
    created: metadata.created,
    updated: metadata.updated,
    vault_name: metadata.vaultName,
    message_count: metadata.messageCount,
    messages: messages.map(msg => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant' | 'tool',
      content: msg.content || '',
      timestamp: msg.timestamp,
      state: msg.state,
      toolCalls: msg.toolCalls?.map(tc => {
        // Handle both formats:
        // 1. Standard OpenAI format: { function: { name, arguments } }
        // 2. Result format from buildToolMetadata: { name, result, success, error }
        const hasFunction = tc.function && typeof tc.function === 'object';
        const name = (hasFunction ? tc.function.name : tc.name) || 'unknown_tool';
        let parameters: unknown;
        if (hasFunction && tc.function.arguments) {
          parameters = parseToolArguments(tc.function.arguments);
        } else {
          parameters = tc.parameters;
        }
        return {
          id: tc.id,
          type: tc.type || 'function',
          name,
          function: tc.function || { name, arguments: JSON.stringify(parameters || {}) },
          parameters: parameters || {},
          result: tc.result,
          success: tc.success,
          error: tc.error
        };
      }),
      reasoning: msg.reasoning,
      metadata: msg.metadata,
      // Branching support - cast needed due to AlternativeMessage vs ConversationMessage type differences
      alternatives: msg.alternatives as unknown as import('../../types/storage/StorageTypes').ConversationMessage[] | undefined,
      activeAlternativeIndex: msg.activeAlternativeIndex
    })),
    // Preserve ALL metadata from storage (parentConversationId, branchType, subagent, etc.)
    // while ensuring chatSettings structure is maintained for compatibility
    metadata: {
      ...meta,  // Spread stored metadata first (parentConversationId, branchType, subagent, etc.)
      chatSettings: {
        ...chatSettings,
        workspaceId: metadata.workspaceId,
        sessionId: metadata.sessionId,
        promptId: getStringValue(chatSettings?.promptId) ?? getStringValue(meta.promptId)
      },
      workflowId: metadata.workflowId ?? getStringValue(meta.workflowId),
      runTrigger: metadata.runTrigger ?? getRunTriggerValue(meta.runTrigger),
      scheduledFor: metadata.scheduledFor ?? getNumberValue(meta.scheduledFor),
      runKey: metadata.runKey ?? getStringValue(meta.runKey),
      cost: resolvedCost
    },
    cost: resolvedCost
  };
}

/**
 * Populate message.branches from unified branch storage.
 *
 * With unified model, branches are separate conversations with parentConversationId
 * and parentMessageId in metadata. This function queries those and converts them
 * to the embedded ConversationBranch format for UI compatibility.
 *
 * @param allBranchConversations - All branch conversations for the parent
 * @param messages - Messages to populate branches on (mutated in place)
 */
export function populateMessageBranches(
  allBranchConversations: IndividualConversation[],
  messages: ConversationMessage[]
): void {
  if (allBranchConversations.length === 0) {
    return;
  }

  // Group branches by parent message ID
  const branchesByMessage = new Map<string, IndividualConversation[]>();
  for (const branch of allBranchConversations) {
    const parentMessageId = branch.metadata?.parentMessageId;
    if (parentMessageId) {
      const existing = branchesByMessage.get(parentMessageId) || [];
      existing.push(branch);
      branchesByMessage.set(parentMessageId, existing);
    }
  }

  // Attach branches to their parent messages
  for (const message of messages) {
    const branchConversations = branchesByMessage.get(message.id);

    if (branchConversations && branchConversations.length > 0) {
      // Convert each branch conversation to embedded ConversationBranch format
      const branches: ConversationBranch[] = branchConversations.map(bc =>
        convertToConversationBranch(bc)
      );

      message.branches = branches;
      // Initialize activeAlternativeIndex if not set (0 = original message)
      if (message.activeAlternativeIndex === undefined) {
        message.activeAlternativeIndex = 0;
      }
    }
  }
}
