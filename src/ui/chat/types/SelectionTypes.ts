/**
 * Selection Types - Interfaces for model and prompt selection
 *
 * Used by: ModelSelectionUtility, TokenCalculator, ModelAgentManager
 */

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  contextWindow: number;
  supportsThinking?: boolean;
}

export interface PromptOption {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
}
