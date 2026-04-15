/**
 * tests/eval/EvalAdapterRegistry.ts — Minimal IAdapterRegistry for eval harness.
 *
 * Wraps pre-constructed adapter instances (e.g., OpenRouterAdapter) in a simple
 * Map-based registry. Avoids the full AdapterRegistry's async init, OAuth flows,
 * and dynamic import complexity. Used by EvalRunner.
 */

import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { LLMProviderSettings } from '../../src/types';
import type { Vault } from 'obsidian';

export class EvalAdapterRegistry implements IAdapterRegistry {
  private adapters: Map<string, BaseAdapter>;

  constructor(entries: Array<[string, BaseAdapter]>) {
    this.adapters = new Map(entries);
  }

  initialize(_settings: LLMProviderSettings, _vault?: Vault): void {
    // No-op: adapters are pre-constructed
  }

  updateSettings(_settings: LLMProviderSettings): void {
    // No-op: adapters are pre-constructed
  }

  getAdapter(providerId: string): BaseAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAvailableProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  isProviderAvailable(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  clear(): void {
    this.adapters.clear();
  }
}
