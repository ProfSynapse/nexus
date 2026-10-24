import type { ConversationMessage } from '../../types/chat/ChatTypes';

/** The exact arguments archived by createState and carried into later prompts. */
export interface SavedCompactionState {
  name: string;
  conversationContext: string;
  activeTask: string;
  activeFiles: string[];
  nextSteps: string[];
}

export function compactionContextText(record: { summary: string; savedState?: SavedCompactionState }): string {
  return record.savedState ? JSON.stringify(record.savedState) : record.summary;
}

/** Include empty assistant tool turns and standalone tool results as evidence. */
export function conversationTranscript(messages: ConversationMessage[]): string {
  return messages.map(message => {
    const lines = [`[${message.role}]: ${message.content}`];
    for (const call of message.toolCalls ?? []) {
      lines.push(
        `Tool: ${call.function?.name ?? call.name ?? 'unknown'}`,
        `Arguments: ${call.function?.arguments ?? JSON.stringify(call.parameters ?? {})}`,
        ...(call.parameters ? [`Parameters: ${JSON.stringify(call.parameters)}`] : []),
        `Status: ${call.success === false ? 'failed' : call.success === true ? 'succeeded' : 'not confirmed'}`,
        `Outcome: ${call.result !== undefined
          ? typeof call.result === 'string' ? call.result : JSON.stringify(call.result)
          : call.error ?? '(no result)'}`
      );
    }
    return lines.join('\n');
  }).join('\n\n');
}
