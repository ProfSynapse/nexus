/**
 * Which thinking levels a provider/model actually distinguishes.
 *
 * Nexus stores one of five efforts (Low, Medium, High, Extra high, Max), but
 * most providers accept fewer and the adapters fold the rest onto a neighbour:
 * Gemini stops at High, older Claude models treat Extra high and Max as High,
 * GPT-5.2 to 5.5 treat Max as Extra high, and so on. A Thinking dropdown that
 * offers every level would show choices that silently do the same thing.
 *
 * `getSupportedThinkingEfforts` returns only the levels that behave
 * differently, using the same mapping functions the adapters use, so this
 * list cannot drift from what is sent. When Nexus has no capability data for
 * a provider or model it returns all five levels (owner decision: "if no
 * capability data exists, show all six" — Off plus five levels).
 *
 * This answers "which levels", not "can it think at all": callers that also
 * need the on/off capability use `registryModelSupportsThinking` or
 * `resolveThinkingForModel`.
 *
 * Pure: no Node or Obsidian imports, safe for settings UI on mobile.
 */

import type { ThinkingEffort } from '../../../types/llm/ProviderTypes';
import {
  clampThinkingEffortToHigh,
  isAnthropicAdaptiveThinkingModel,
  mapAnthropicAdaptiveEffort,
  mapOpenAIThinkingEffort
} from './ThinkingEffortMapper';

/** Every effort Nexus can store, lowest first. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** For one provider/model, the level that a stored effort behaves as. */
type EffortBehaviour = (effort: ThinkingEffort, model: string) => ThinkingEffort;

const ONLY_HIGH: EffortBehaviour = () => 'high';

/** Mistral Large 4 takes a binary reasoning switch, sent as `high`. */
function isMistralLarge4(model: string): boolean {
  return model === 'mistral-large-4' || model === 'mistral-large-4-0' || model === 'mistral/mistral-large-4';
}

function getEffortBehaviour(provider: string, model: string): EffortBehaviour | null {
  switch (provider) {
    case 'anthropic':
      // Manual-budget models (Claude 4.5 and older) lift Extra high and Max
      // above High through the token budget, so every level is distinct.
      return isAnthropicAdaptiveThinkingModel(model) ? mapAnthropicAdaptiveEffort : null;
    case 'anthropic-claude-code':
      // The CLI always passes `--effort` through the adaptive mapping.
      return mapAnthropicAdaptiveEffort;
    case 'openai':
    case 'openai-codex':
      return mapOpenAIThinkingEffort;
    case 'google':
      // Gemini 3 thinking levels and the legacy token budgets both stop at
      // High; Gemini 3 Pro Preview has no Medium level.
      return model.startsWith('gemini-3-pro-preview')
        ? (effort: ThinkingEffort) => {
          const level = clampThinkingEffortToHigh(effort);
          return level === 'medium' ? 'high' : level;
        }
        : clampThinkingEffortToHigh;
    case 'google-gemini-cli':
    case 'groq':
      return clampThinkingEffortToHigh;
    case 'deepseek':
      // DeepSeek accepts `high` and `max`. Low and Medium send `high`; High
      // and above send `max`. Offer one level per behaviour: Medium and Max.
      return (effort: ThinkingEffort) => (effort === 'low' || effort === 'medium' ? 'medium' : 'max');
    case 'mistral':
    case 'requesty':
      return isMistralLarge4(model) ? ONLY_HIGH : null;
    case 'openrouter':
      return model.replace(/:online$/, '') === 'mistralai/mistral-large-4-0' ? ONLY_HIGH : null;
    default:
      return null;
  }
}

/**
 * The thinking levels this provider/model distinguishes, lowest first.
 * All five when there is no capability data.
 */
export function getSupportedThinkingEfforts(
  provider: string | null | undefined,
  model: string | null | undefined
): ThinkingEffort[] {
  const behaviour = provider && model ? getEffortBehaviour(provider, model) : null;
  if (!behaviour || !model) return [...THINKING_EFFORTS];

  const supported: ThinkingEffort[] = [];
  for (const effort of THINKING_EFFORTS) {
    const behavesAs = behaviour(effort, model);
    if (!supported.includes(behavesAs)) supported.push(behavesAs);
  }
  return THINKING_EFFORTS.filter(effort => supported.includes(effort));
}

/**
 * The supported level a stored effort behaves as for this provider/model, so a
 * dropdown can show the value that will really be used without rewriting the
 * stored preference. Unknown models return the effort unchanged.
 */
export function normalizeThinkingEffortForModel(
  provider: string | null | undefined,
  model: string | null | undefined,
  effort: ThinkingEffort
): ThinkingEffort {
  const behaviour = provider && model ? getEffortBehaviour(provider, model) : null;
  if (!behaviour || !model) return effort;
  return behaviour(effort, model);
}
