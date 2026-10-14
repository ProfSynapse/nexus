/**
 * The model the Subagents settings describe. A configured subagent model wins;
 * without one, subagents run on the chat model when it is a cloud model (the
 * runtime precedence in SubagentModelResolver), so the Creativity and Context
 * window rows, and their saved limit key, follow that model.
 *
 * Pure; mobile-safe.
 */

import { isLocalProvider } from '../../../services/llm/utils/SubagentModelResolver';
import type { ChatSettings } from './types';

export interface SubagentTarget {
  provider?: string;
  model?: string;
  /** True when no subagent model is set and the chat model is used. */
  inherited: boolean;
}

export function resolveSubagentTarget(
  settings: Pick<ChatSettings, 'provider' | 'model' | 'agentProvider' | 'agentModel'>
): SubagentTarget {
  if (settings.agentProvider && settings.agentModel) {
    return { provider: settings.agentProvider, model: settings.agentModel, inherited: false };
  }
  if (settings.provider && settings.model && !isLocalProvider(settings.provider)) {
    return { provider: settings.provider, model: settings.model, inherited: true };
  }
  return { inherited: true };
}
