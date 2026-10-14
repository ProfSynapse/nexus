/**
 * Which model, thinking, temperature and context budget an agent run uses.
 *
 * "Agent runs" are subagents and executePrompt (saved prompts and
 * automations). Their settings live under Settings → Defaults → Subagents and
 * in each chat's settings, and this module is the single place that decides
 * how those layers combine. LLMService, the subagent path and PromptExecutor
 * all call it, so the three cannot disagree.
 *
 * Model precedence (first match wins):
 *   1. an explicit tool parameter (`explicit`)
 *   2. the conversation's subagent provider/model (`conversation`)
 *   3. the default subagent model (`llmProviders.agentModel`)
 *   4. the chat model, if it is a cloud model (behaviour before this existed)
 *   5. the first available cloud provider (the old local-model fallback)
 *
 * A configured agent model (levels 2 and 3) on a provider that is no longer
 * available is skipped rather than sent to a request that cannot succeed.
 *
 * Pure: no Node or Obsidian imports.
 */

import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../../ui/chat/utils/ContextWindowSettings';
import { getRegistryContextWindow, modelAcceptsSamplingParams } from './modelCapabilityLookup';
import { resolveThinkingForModel, type ThinkingPreference } from './resolveThinkingForModel';

/** Providers that run on this device. Agent runs prefer cloud models. */
export const LOCAL_PROVIDERS: readonly string[] = ['webllm', 'ollama', 'lmstudio'];

export function isLocalProvider(provider: string | null | undefined): boolean {
  return !!provider && LOCAL_PROVIDERS.includes(provider);
}

export interface ModelRef {
  provider?: string | null;
  model?: string | null;
}

export type AgentModelSource =
  | 'explicit'
  | 'conversation'
  | 'default-agent'
  | 'chat'
  | 'cloud-fallback'
  | 'unresolved';

export interface ResolveAgentModelInput {
  explicit?: ModelRef | null;
  conversation?: ModelRef | null;
  defaultAgent?: ModelRef | null;
  chat?: ModelRef | null;
  /**
   * Providers that can serve a request right now. When given, configured
   * agent models and the chat model on other providers are skipped, and the
   * cloud fallback picks from this list. When omitted nothing is skipped.
   */
  availableProviders?: readonly string[];
  /**
   * Model to use with a cloud-fallback provider. Without it the fallback
   * leaves the model empty and the caller picks one.
   */
  defaultModelFor?: (provider: string) => string | undefined;
}

export interface ResolvedAgentModel {
  provider: string;
  /** Empty when only the provider is known; the caller picks a model. */
  model: string;
  source: AgentModelSource;
}

function isComplete(ref: ModelRef | null | undefined): ref is { provider: string; model: string } {
  return !!ref?.provider && !!ref.model;
}

export function resolveAgentModel(input: ResolveAgentModelInput): ResolvedAgentModel {
  const available = input.availableProviders;
  const isAvailable = (provider: string): boolean => !available || available.includes(provider);

  const explicit = input.explicit;
  if (explicit?.provider) {
    // A provider without a model borrows the model of a lower layer on the
    // same provider, as executePrompt always has.
    const sameProvider = [input.conversation, input.defaultAgent, input.chat]
      .find(ref => isComplete(ref) && ref.provider === explicit.provider);
    return {
      provider: explicit.provider,
      model: explicit.model || sameProvider?.model || '',
      source: 'explicit'
    };
  }

  if (isComplete(input.conversation) && isAvailable(input.conversation.provider)) {
    return { provider: input.conversation.provider, model: input.conversation.model, source: 'conversation' };
  }

  if (isComplete(input.defaultAgent) && isAvailable(input.defaultAgent.provider)) {
    return { provider: input.defaultAgent.provider, model: input.defaultAgent.model, source: 'default-agent' };
  }

  const chat = input.chat;
  if (isComplete(chat) && !isLocalProvider(chat.provider) && isAvailable(chat.provider)) {
    return { provider: chat.provider, model: chat.model, source: 'chat' };
  }

  const cloudProvider = available?.find(provider => !isLocalProvider(provider));
  if (cloudProvider) {
    return { provider: cloudProvider, model: input.defaultModelFor?.(cloudProvider) || '', source: 'cloud-fallback' };
  }

  // Nothing usable. Return the chat model so the caller reports a real error.
  return { provider: chat?.provider || '', model: chat?.model || '', source: 'unresolved' };
}

/** Per-conversation agent settings, as stored in chat settings. */
export interface ConversationAgentSettings {
  provider?: string | null;
  model?: string | null;
  thinking?: ThinkingPreference | null;
  /** Creativity for agent runs in this chat. Null or absent inherits the default. */
  temperature?: number | null;
  /** Context budget for agent runs in this chat. Null or absent inherits the default. */
  contextWindow?: number | null;
}

/** The plugin-wide defaults that agent runs fall back to. */
export interface AgentDefaults {
  model?: ModelRef | null;
  thinking?: ThinkingPreference | null;
  /** `llmProviders.agentTemperature`. */
  agentTemperature?: number;
  /** `llmProviders.defaultTemperature`, used when no agent temperature is set. */
  defaultTemperature?: number;
  /** `llmProviders.agentContextWindowOverrides`. */
  contextWindowOverrides?: Record<string, number>;
}

export interface AgentRunSettingsInput {
  provider: string;
  model: string;
  conversation?: ConversationAgentSettings | null;
  defaults?: AgentDefaults | null;
  /** A window the caller already knows (e.g. a discovered local model). */
  advertisedContextWindow?: number;
}

export interface AgentRunSettings {
  /** Already gated: `enabled` is false for models that cannot think. */
  thinking: ThinkingSettings;
  /** Undefined when the model rejects sampling parameters. */
  temperature?: number;
  /** Undefined when neither a limit nor the model's window is known. */
  contextWindow?: number;
}

export const DEFAULT_AGENT_TEMPERATURE = 0.5;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The Creativity an agent run would use before model gating. */
export function resolveAgentTemperature(
  conversation?: Pick<ConversationAgentSettings, 'temperature'> | null,
  defaults?: Pick<AgentDefaults, 'agentTemperature' | 'defaultTemperature'> | null
): number {
  const value = finiteNumber(conversation?.temperature)
    ?? finiteNumber(defaults?.agentTemperature)
    ?? finiteNumber(defaults?.defaultTemperature)
    ?? DEFAULT_AGENT_TEMPERATURE;
  return Math.max(0, Math.min(1, value));
}

export function resolveAgentRunSettings(input: AgentRunSettingsInput): AgentRunSettings {
  const { provider, model, conversation, defaults } = input;

  const thinking = resolveThinkingForModel(
    provider,
    model,
    conversation?.thinking ?? defaults?.thinking ?? { enabled: false }
  );

  const temperature = modelAcceptsSamplingParams(provider, model)
    ? resolveAgentTemperature(conversation, defaults)
    : undefined;

  const advertised = finiteNumber(input.advertisedContextWindow) ?? getRegistryContextWindow(provider, model);
  const override = finiteNumber(conversation?.contextWindow)
    ?? (provider && model
      ? finiteNumber(defaults?.contextWindowOverrides?.[getContextWindowOverrideKey(provider, model)])
      : undefined);

  let contextWindow: number | undefined;
  if (advertised && advertised > 0) {
    contextWindow = resolveContextWindowLimit(advertised, override);
  } else if (override !== undefined && override > 0) {
    contextWindow = Math.floor(override);
  }

  return { thinking, temperature, contextWindow };
}
