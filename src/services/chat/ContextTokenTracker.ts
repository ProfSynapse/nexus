/**
 * ContextTokenTracker
 *
 * Tracks token usage for context-limited models (especially Nexus/WebLLM).
 * Uses hybrid approach:
 * - Actual counts from generation usage (accurate)
 * - Estimates from gpt-tokenizer for new messages (approximate)
 *
 * Provides context status for system prompts and triggers auto-compaction.
 */

import { encode } from 'gpt-tokenizer';

export interface ContextStatus {
  usedTokens: number;
  maxTokens: number;
  percentUsed: number;
  status: 'ok' | 'warning' | 'critical';
  shouldCompact: boolean;
}

export interface TokenUsageRecord {
  promptTokens: number;
  completionTokens: number;
  timestamp: number;
}

/**
 * Thresholds for context management (as percentage of max tokens)
 * Using 90% for compaction trigger since gpt-tokenizer gives precise estimates
 */
const THRESHOLDS = {
  WARNING: 0.75,   // 75% - show warning in status
  CRITICAL: 0.90,  // 90% - trigger LLM saveState subprocess
  RESERVE: 0.05,   // 5% - reserved for compaction overhead
} as const;

export class ContextTokenTracker {
  private maxTokens: number;
  private systemPromptTokens: number = 0;
  private conversationTokens: number = 0;
  private usageHistory: TokenUsageRecord[] = [];

  constructor(maxContextWindow: number = 4096) {
    this.maxTokens = maxContextWindow;
  }

  /**
   * Estimate token count for a string using gpt-tokenizer
   * Accuracy: ~85-90% for Qwen/Nexus models
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    try {
      return encode(text).length;
    } catch {
      // Fallback: rough estimate based on character count
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Set the system prompt tokens (estimated once at session start)
   */
  setSystemPromptTokens(systemPrompt: string): void {
    this.systemPromptTokens = this.estimateTokens(systemPrompt);
  }

  /**
   * Record actual token usage from a generation response
   * This is the source of truth for consumed tokens
   */
  recordUsage(promptTokens: number, completionTokens: number): void {
    // Update running total based on actual usage
    // The promptTokens includes system prompt + conversation history
    // We use this to correct our estimates
    this.conversationTokens = promptTokens + completionTokens - this.systemPromptTokens;

    this.usageHistory.push({
      promptTokens,
      completionTokens,
      timestamp: Date.now(),
    });

    // Keep only last 20 records for memory efficiency
    if (this.usageHistory.length > 20) {
      this.usageHistory = this.usageHistory.slice(-20);
    }
  }

  /**
   * Estimate tokens for a new message (before sending)
   * Used to check if we need to compact before sending
   */
  estimateWithNewMessage(newMessage: string): number {
    const newMessageTokens = this.estimateTokens(newMessage);
    return this.getTotalUsed() + newMessageTokens;
  }

  /**
   * Get total tokens currently used
   */
  getTotalUsed(): number {
    return this.systemPromptTokens + this.conversationTokens;
  }

  /**
   * Get available tokens (accounting for reserve)
   */
  getAvailableTokens(): number {
    const reserved = Math.floor(this.maxTokens * THRESHOLDS.RESERVE);
    return this.maxTokens - reserved - this.getTotalUsed();
  }

  /**
   * Get current context status
   */
  getStatus(): ContextStatus {
    const usedTokens = this.getTotalUsed();
    const percentUsed = usedTokens / this.maxTokens;

    let status: ContextStatus['status'] = 'ok';
    if (percentUsed >= THRESHOLDS.CRITICAL) {
      status = 'critical';
    } else if (percentUsed >= THRESHOLDS.WARNING) {
      status = 'warning';
    }

    return {
      usedTokens,
      maxTokens: this.maxTokens,
      percentUsed: Math.round(percentUsed * 100),
      status,
      shouldCompact: percentUsed >= THRESHOLDS.CRITICAL,
    };
  }

  /**
   * Generate context status string for system prompt
   * Gives the model awareness of its token limits
   */
  getStatusForPrompt(): string {
    const status = this.getStatus();
    const availableTokens = this.getAvailableTokens();

    if (status.status === 'ok') {
      return `Context: ${status.percentUsed}% used (${availableTokens} tokens available)`;
    }

    if (status.status === 'warning') {
      return `Context: ${status.percentUsed}% used - approaching limit. Consider saving state with saveState tool.`;
    }

    // Critical
    return `Context: ${status.percentUsed}% CRITICAL - context nearly full. Use saveState tool immediately to preserve conversation.`;
  }

  /**
   * Check if compaction should be triggered before sending a message
   */
  shouldCompactBeforeSending(newMessage: string): boolean {
    const projectedTokens = this.estimateWithNewMessage(newMessage);
    const projectedPercent = projectedTokens / this.maxTokens;
    return projectedPercent >= THRESHOLDS.CRITICAL;
  }

  /**
   * Reset tracker (after compaction or new session)
   */
  reset(): void {
    this.conversationTokens = 0;
    this.usageHistory = [];
    // Keep systemPromptTokens - it doesn't change
  }

  /**
   * Set conversation tokens after loading a state
   * Used when restoring from a saved state
   */
  setConversationTokens(tokens: number): void {
    this.conversationTokens = tokens;
  }

  /**
   * Update max tokens (e.g., when switching models)
   */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  /**
   * Get last N usage records for debugging/analytics
   */
  getUsageHistory(count: number = 10): TokenUsageRecord[] {
    return this.usageHistory.slice(-count);
  }
}
