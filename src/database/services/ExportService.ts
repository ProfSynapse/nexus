/**
 * Location: src/database/services/ExportService.ts
 *
 * Export Service
 *
 * Handles data export in various formats following Single Responsibility Principle.
 * Separated from HybridStorageAdapter to keep concerns focused.
 *
 * Export Formats:
 * - OpenAI Fine-tuning: JSONL format for model training
 * - Full Backup: Complete data export for migration/backup
 *
 * Related Files:
 * - src/database/adapters/HybridStorageAdapter.ts - Storage adapter
 * - src/database/repositories/* - Data repositories
 * - src/types/storage/HybridStorageTypes.ts - Export data types
 */

import { App } from 'obsidian';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { MessageRepository } from '../repositories/MessageRepository';
import { ExportFilter, ExportData, MessageData, ConversationExportData, WorkspaceExportData } from '../../types/storage/HybridStorageTypes';

/**
 * Dependencies for ExportService
 * Following Dependency Inversion Principle - depends on abstractions
 */
export interface ExportServiceDependencies {
  app: App;
  conversationRepo: ConversationRepository;
  messageRepo: MessageRepository;
  // Workspace-related repos (if needed for full export)
  workspaceRepo?: any;
  sessionRepo?: any;
  stateRepo?: any;
  traceRepo?: any;
}

/**
 * Export service for data export operations
 *
 * Provides methods to export data in various formats:
 * - Fine-tuning format for LLM training
 * - Full backup format for data migration
 */
export class ExportService {
  private deps: ExportServiceDependencies;

  constructor(deps: ExportServiceDependencies) {
    this.deps = deps;
  }

  // ============================================================================
  // OpenAI Fine-tuning Export
  // ============================================================================

  /**
   * Export conversations in OpenAI fine-tuning format
   *
   * Format: One conversation per line, each line is a JSON object:
   * {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, ...]}
   *
   * @param filter - Optional filter for which conversations to export
   * @returns JSONL string ready for OpenAI fine-tuning API
   */
  async exportForFineTuning(filter?: ExportFilter): Promise<string> {
    const output: string[] = [];

    // Get all conversations (paginated to handle large datasets)
    // Include branches for complete export
    const conversations = await this.deps.conversationRepo.getConversations({
      pageSize: 1000,
      sortBy: 'created',
      sortOrder: 'asc',
      includeBranches: true
    });

    for (const conv of conversations.items) {
      // Apply filters
      if (filter?.conversationIds && !filter.conversationIds.includes(conv.id)) {
        continue;
      }
      if (filter?.startDate && conv.created < filter.startDate) {
        continue;
      }
      if (filter?.endDate && conv.created > filter.endDate) {
        continue;
      }
      if (filter?.workspaceId && conv.workspaceId !== filter.workspaceId) {
        continue;
      }

      // Get all messages for this conversation
      const messagesResult = await this.deps.messageRepo.getMessages(conv.id, {
        pageSize: 10000
      });

      // Filter messages based on export filter
      const filteredMessages = messagesResult.items
        .filter(m => m.state === 'complete') // Only export complete messages
        .filter(m => filter?.includeSystem !== false || m.role !== 'system')
        .filter(m => filter?.includeTools !== false || m.role !== 'tool');

      if (filteredMessages.length === 0) {
        continue; // Skip conversations with no exportable messages
      }

      // Format messages for OpenAI fine-tuning
      const formattedMessages = filteredMessages.map(m => this.formatMessageForExport(m));

      // Inject system prompt from metadata if available and not already present
      const chatSettings = conv.metadata?.chatSettings as { systemPrompt?: string } | undefined;
      const systemPrompt = chatSettings?.systemPrompt;
      if (systemPrompt && filter?.includeSystem !== false) {
        const hasSystemMessage = formattedMessages.length > 0 && formattedMessages[0].role === 'system';
        if (!hasSystemMessage) {
          formattedMessages.unshift({
            role: 'system',
            content: systemPrompt
          });
        }
      }

      // Output as single JSONL line
      output.push(JSON.stringify({ messages: formattedMessages }));
    }

    return output.join('\n');
  }

  /**
   * Format a message for OpenAI export
   */
  private formatMessageForExport(message: MessageData): any {
    const formatted: any = {
      role: message.role,
      content: message.content
    };

    // Include tool calls if present
    if (message.toolCalls && message.toolCalls.length > 0) {
      formatted.tool_calls = message.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments
        }
      }));
    }

    // Include tool call ID if this is a tool response
    if (message.toolCallId) {
      formatted.tool_call_id = message.toolCallId;
    }

    return formatted;
  }

  // ============================================================================
  // Full Data Export
  // ============================================================================

  /**
   * Export all data for backup or migration
   *
   * Includes:
   * - All conversations with messages
   * - All workspaces with sessions, states, and traces (if repos provided)
   *
   * @returns Complete export data structure
   */
  async exportAllData(): Promise<ExportData> {
    const exportedAt = Date.now();

    // Export conversations
    const conversations = await this.exportAllConversations();

    // Export workspaces (if repository provided)
    const workspaces = this.deps.workspaceRepo
      ? await this.exportAllWorkspaces()
      : [];

    return {
      version: '1.0.0',
      exportedAt,
      deviceId: this.getDeviceId(),
      workspaces,
      conversations
    };
  }

  /**
   * Export all conversations with messages
   */
  private async exportAllConversations(): Promise<ConversationExportData[]> {
    // Include branches for complete backup
    const conversationsResult = await this.deps.conversationRepo.getConversations({
      pageSize: 10000,
      includeBranches: true
    });

    return Promise.all(
      conversationsResult.items.map(async (conv) => {
        const messagesResult = await this.deps.messageRepo.getMessages(conv.id, {
          pageSize: 10000
        });

        return {
          metadata: conv,
          messages: messagesResult.items
        };
      })
    );
  }

  /**
   * Export all workspaces with related data
   */
  private async exportAllWorkspaces(): Promise<WorkspaceExportData[]> {
    if (!this.deps.workspaceRepo) {
      return [];
    }

    const workspacesResult = await this.deps.workspaceRepo.getWorkspaces({
      pageSize: 10000
    });

    return Promise.all(
      workspacesResult.items.map(async (ws: { id: string }) => {
        // Get sessions
        const sessions = this.deps.sessionRepo
          ? (await this.deps.sessionRepo.getByWorkspaceId(ws.id, { pageSize: 10000 })).items
          : [];

        // Get states
        const states = this.deps.stateRepo
          ? (await this.deps.stateRepo.getStates(ws.id, undefined, { pageSize: 10000 })).items
          : [];

        // Get traces
        const traces = this.deps.traceRepo
          ? (await this.deps.traceRepo.getTraces(ws.id, undefined, { pageSize: 10000 })).items
          : [];

        return {
          metadata: ws,
          sessions,
          states,
          traces
        };
      })
    );
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Get device ID from localStorage
   */
  private getDeviceId(): string {
    return localStorage.getItem('claudesidian-device-id') ?? 'unknown';
  }
}
