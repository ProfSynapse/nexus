/**
 * LLMSettingsNotifier - Event system for LLM provider settings changes
 *
 * Uses Obsidian's Events API for consistency with the rest of the codebase.
 * Allows components to subscribe to settings changes and react immediately
 * when API keys are added/removed or providers are enabled/disabled.
 */

import { Events, EventRef } from 'obsidian';
import { LLMProviderSettings } from '../../types';

/**
 * Singleton notifier for LLM settings changes
 * Extends Obsidian's Events for consistent event handling
 */
class LLMSettingsNotifierImpl extends Events {
  /**
   * Subscribe to settings changes
   * @param callback Handler function called when settings change
   * @returns EventRef for unsubscribing
   */
  onSettingsChanged(callback: (settings: LLMProviderSettings) => void): EventRef {
    // Cast to satisfy Obsidian's generic event signature
    return this.on('settings-changed', callback as (...data: unknown[]) => unknown);
  }

  /**
   * Notify all subscribers of settings change
   */
  notify(settings: LLMProviderSettings): void {
    this.trigger('settings-changed', settings);
  }

  /**
   * Subscribe to Apps settings changes. ElevenLabs speech is keyed there, so a
   * provider change alone does not cover it.
   */
  onAppsChanged(callback: () => void): EventRef {
    return this.on('apps-changed', callback);
  }

  notifyAppsChanged(): void {
    this.trigger('apps-changed');
  }

  /**
   * Unsubscribe using EventRef
   */
  unsubscribe(ref: EventRef): void {
    this.offref(ref);
  }
}

// Export singleton instance
export const LLMSettingsNotifier = new LLMSettingsNotifierImpl();
