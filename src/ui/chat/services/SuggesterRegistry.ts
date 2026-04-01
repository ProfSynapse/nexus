/**
 * SuggesterRegistry - Manages all suggester instances
 * Coordinates activation, tracks state, and provides central access point
 */

import { App } from 'obsidian';
import { BaseSuggester } from '../components/suggesters/base/BaseSuggester';
import {
  SuggesterType,
  SuggesterStatus
} from '../components/suggesters/base/SuggesterInterfaces';
import { MessageEnhancer } from './MessageEnhancer';

/**
 * Central registry for managing all suggester instances
 */
export class SuggesterRegistry {

  private app: App;
  private suggesters = new Map<SuggesterType, BaseSuggester<unknown>>();
  private messageEnhancer: MessageEnhancer;
  private activeSuggesters = new Set<SuggesterType>();

  constructor(app: App) {
    this.app = app;
    this.messageEnhancer = new MessageEnhancer();
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Register a suggester instance
   * @param type - Suggester type
   * @param suggester - Suggester instance
   */
  register<T>(type: SuggesterType, suggester: BaseSuggester<T>): void {
    this.suggesters.set(type, suggester);
  }

  /**
   * Unregister a suggester
   * @param type - Suggester type
   */
  unregister(type: SuggesterType): void {
    const suggester = this.suggesters.get(type);
    if (suggester) {
      // Clean up suggester resources
      if (typeof suggester.onDestroy === 'function') {
        suggester.onDestroy();
      }
      this.suggesters.delete(type);
      this.activeSuggesters.delete(type);
    }
  }

  /**
   * Unregister all suggesters
   */
  unregisterAll(): void {
    this.suggesters.forEach((suggester, type) => {
      this.unregister(type);
    });
  }

  // ==========================================================================
  // Access
  // ==========================================================================

  /**
   * Get a specific suggester
   * @param type - Suggester type
   * @returns Suggester instance or undefined
   */
  get<T>(type: SuggesterType): BaseSuggester<T> | undefined {
    return this.suggesters.get(type) as BaseSuggester<T> | undefined;
  }

  /**
   * Get all registered suggesters
   * @returns Map of all suggesters
   */
  getAll(): Map<SuggesterType, BaseSuggester<unknown>> {
    return new Map(this.suggesters);
  }

  /**
   * Get message enhancer instance
   * @returns MessageEnhancer
   */
  getMessageEnhancer(): MessageEnhancer {
    return this.messageEnhancer;
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Mark a suggester as active
   * @param type - Suggester type
   */
  setActive(type: SuggesterType): void {
    this.activeSuggesters.add(type);
  }

  /**
   * Mark a suggester as inactive
   * @param type - Suggester type
   */
  setInactive(type: SuggesterType): void {
    this.activeSuggesters.delete(type);
  }

  /**
   * Check if a suggester is active
   * @param type - Suggester type
   * @returns True if active
   */
  isActive(type: SuggesterType): boolean {
    return this.activeSuggesters.has(type);
  }

  /**
   * Get all active suggester types
   * @returns Set of active suggester types
   */
  getActiveTypes(): Set<SuggesterType> {
    return new Set(this.activeSuggesters);
  }

  /**
   * Check if any suggester is active
   * @returns True if at least one suggester is active
   */
  hasActiveSuggester(): boolean {
    return this.activeSuggesters.size > 0;
  }

  /**
   * Deactivate all suggesters
   */
  deactivateAll(): void {
    this.activeSuggesters.clear();
  }

  /**
   * Get status for a specific suggester
   * @param type - Suggester type
   * @returns Status object
   */
  getStatus(type: SuggesterType): SuggesterStatus {
    return {
      active: this.isActive(type)
    };
  }

  /**
   * Get status for all suggesters
   * @returns Map of statuses
   */
  getAllStatuses(): Map<SuggesterType, SuggesterStatus> {
    const statuses = new Map<SuggesterType, SuggesterStatus>();

    this.suggesters.forEach((_, type) => {
      statuses.set(type, this.getStatus(type));
    });

    return statuses;
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  /**
   * Check if a suggester type is registered
   * @param type - Suggester type
   * @returns True if registered
   */
  has(type: SuggesterType): boolean {
    return this.suggesters.has(type);
  }

  /**
   * Get count of registered suggesters
   * @returns Number of suggesters
   */
  count(): number {
    return this.suggesters.size;
  }

  /**
   * Clear all suggester caches
   */
  clearAllCaches(): void {
    this.suggesters.forEach(suggester => {
      if (typeof suggester.clearCache === 'function') {
        suggester.clearCache();
      }
    });
  }

  /**
   * Reset the message enhancer
   */
  resetMessageEnhancer(): void {
    this.messageEnhancer.clearEnhancements();
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    this.unregisterAll();
    this.messageEnhancer.clearEnhancements();
  }
}
