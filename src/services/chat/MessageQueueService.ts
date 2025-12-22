/**
 * MessageQueueService - Async message queue with priority handling
 *
 * Responsibilities:
 * - Queue messages during active generation
 * - Process queue when generation completes
 * - User messages get priority over subagent results
 * - Emit events for UI updates
 *
 * Follows Single Responsibility Principle - only handles message queuing.
 */

import { EventEmitter } from 'events';
import type { QueuedMessage, MessageQueueEvents } from '../../types/branch/BranchTypes';

export interface MessageQueueServiceEvents extends MessageQueueEvents {}

export class MessageQueueService extends EventEmitter {
  private queue: QueuedMessage[] = [];
  private isGenerating: boolean = false;
  private processMessageFn: ((message: QueuedMessage) => Promise<void>) | null = null;

  constructor() {
    super();
  }

  /**
   * Set the message processor function
   * This function is called for each message when processing the queue
   */
  setMessageProcessor(fn: (message: QueuedMessage) => Promise<void>): void {
    this.processMessageFn = fn;
  }

  /**
   * Alias for setMessageProcessor (for compatibility with MessageManager)
   */
  setProcessor(fn: (message: QueuedMessage) => Promise<void>): void {
    this.setMessageProcessor(fn);
  }

  /**
   * Enqueue a message
   * - If not generating, process immediately
   * - If generating, add to queue (user messages get priority)
   */
  async enqueue(message: QueuedMessage): Promise<void> {
    console.log('[MessageQueue] enqueue:', { type: message.type, isGenerating: this.isGenerating });
    if (this.isGenerating) {
      this.addToQueue(message);
      console.log('[MessageQueue] Queued for later, length:', this.queue.length);
      this.emit('message:queued', { count: this.queue.length, message });
    } else {
      console.log('[MessageQueue] Processing immediately');
      await this.processMessage(message);
    }
  }

  /**
   * Add message to queue with priority handling
   * User messages go to front (after other user messages)
   * Subagent results and system messages go to back
   */
  private addToQueue(message: QueuedMessage): void {
    if (message.type === 'user') {
      // User messages go to front, after any existing user messages
      const lastUserIndex = this.findLastUserMessageIndex();
      this.queue.splice(lastUserIndex + 1, 0, message);
    } else {
      // Subagent results and system messages go to back
      this.queue.push(message);
    }
  }

  /**
   * Find the index of the last user message in the queue
   */
  private findLastUserMessageIndex(): number {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].type === 'user') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Called when generation starts
   * Queue mode is activated - messages will be queued instead of processed
   */
  onGenerationStart(): void {
    this.isGenerating = true;
  }

  /**
   * Called when generation completes
   * Processes all queued messages in order
   */
  async onGenerationComplete(): Promise<void> {
    this.isGenerating = false;
    await this.processQueue();
  }

  /**
   * Process all messages in the queue
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.isGenerating) {
      const message = this.queue.shift()!;
      await this.processMessage(message);
    }

    if (this.queue.length === 0) {
      this.emit('queue:empty');
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    if (!this.processMessageFn) {
      console.error('[MessageQueue] No message processor set');
      return;
    }

    this.emit('message:processing', { message });

    try {
      await this.processMessageFn(message);
    } catch (error) {
      console.error('[MessageQueue] Error processing message:', error);
    }
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get queued messages (for UI display)
   */
  getQueuedMessages(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Check if currently in generation mode
   */
  isInGenerationMode(): boolean {
    return this.isGenerating;
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.queue = [];
    this.emit('queue:empty');
  }

  /**
   * Remove a specific message from the queue by ID
   */
  removeFromQueue(messageId: string): boolean {
    const index = this.queue.findIndex(m => m.id === messageId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Check if a message is in the queue
   */
  isInQueue(messageId: string): boolean {
    return this.queue.some(m => m.id === messageId);
  }

  /**
   * Get the position of a message in the queue (0-indexed)
   */
  getQueuePosition(messageId: string): number {
    return this.queue.findIndex(m => m.id === messageId);
  }
}
