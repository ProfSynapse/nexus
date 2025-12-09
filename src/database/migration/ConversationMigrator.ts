/**
 * Location: src/database/migration/ConversationMigrator.ts
 *
 * Migrates conversation data from legacy JSON to JSONL format.
 * Handles conversations and messages in OpenAI fine-tuning format.
 *
 * Extends BaseMigrator for DRY file iteration and status tracking.
 * Uses batched writes for performance (single file operation per conversation).
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../storage/JSONLWriter';
import { IndividualConversation } from '../../types/storage/StorageTypes';
import { ConversationCreatedEvent, MessageEvent, ConversationEvent } from '../interfaces/StorageEvents';
import { LegacyFileScanner } from './LegacyFileScanner';
import { MigrationStatusTracker } from './MigrationStatusTracker';
import { BaseMigrator } from './BaseMigrator';
import { ConversationMigrationResult, MigrationCategory } from './types';

export class ConversationMigrator extends BaseMigrator<ConversationMigrationResult> {
  protected readonly category: MigrationCategory = 'conversations';

  constructor(
    app: App,
    jsonlWriter: JSONLWriter,
    fileScanner: LegacyFileScanner,
    statusTracker: MigrationStatusTracker
  ) {
    super(app, jsonlWriter, fileScanner, statusTracker);
  }

  protected async listFiles(): Promise<string[]> {
    return this.fileScanner.listLegacyConversationFilePaths();
  }

  protected createEmptyResult(): ConversationMigrationResult {
    return {
      conversations: 0,
      messages: 0,
      errors: [],
    };
  }

  /**
   * Migrate a single conversation file using batched writes for performance
   */
  protected async migrateFile(
    filePath: string,
    result: ConversationMigrationResult
  ): Promise<void> {
    // Read legacy conversation JSON via adapter
    const content = await this.app.vault.adapter.read(filePath);
    const conversation: IndividualConversation = JSON.parse(content);

    // Collect all events for this conversation
    const events: Array<Omit<ConversationEvent, 'id' | 'deviceId' | 'timestamp'>> = [];

    // Conversation metadata event (first line in JSONL)
    events.push({
      type: 'metadata',
      data: {
        id: conversation.id,
        title: conversation.title,
        created: conversation.created,
        vault: conversation.vault_name,
        settings: conversation.metadata?.chatSettings,
      },
    } as Omit<ConversationCreatedEvent, 'id' | 'deviceId' | 'timestamp'>);
    result.conversations++;

    // Collect message events
    if (conversation.messages && conversation.messages.length > 0) {
      // Sort messages by timestamp to ensure correct order
      const sortedMessages = [...conversation.messages].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      console.log(`[ConversationMigrator]   → ${sortedMessages.length} messages`);

      for (let i = 0; i < sortedMessages.length; i++) {
        const message = sortedMessages[i];
        const anyMsg = message as any;
        events.push({
          type: 'message',
          conversationId: conversation.id,
          data: {
            id: message.id,
            role: message.role,
            content: message.content,
            state: message.state,
            sequenceNumber: i,
            tool_calls: message.toolCalls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function?.name || tc.name || '',
                arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {}),
              },
            })),
            // Branching support - migrate alternatives from legacy JSON
            alternatives: anyMsg.alternatives?.map((alt: any) => ({
              id: alt.id,
              content: alt.content,
              timestamp: alt.timestamp,
              tool_calls: alt.toolCalls?.map((tc: any) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.function?.name || tc.name || '',
                  arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {}),
                },
              })),
              reasoning: alt.reasoning,
              state: alt.state || 'complete',
            })),
            activeAlternativeIndex: anyMsg.activeAlternativeIndex ?? 0,
          },
        } as Omit<MessageEvent, 'id' | 'deviceId' | 'timestamp'>);
        result.messages++;
      }
    }

    // Write all events in a single operation
    const jsonlPath = `conversations/conv_${conversation.id}.jsonl`;
    console.log(`[ConversationMigrator]   → Writing ${events.length} events to ${jsonlPath}`);
    await this.jsonlWriter.appendEvents(jsonlPath, events);
  }
}
