/**
 * Selection Types - Interfaces for model and agent selection
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

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
}
