/**
 * LM Studio Model Specifications
 * Models are discovered dynamically from the LM Studio server
 * This file provides helper functions and type definitions
 */

import { ModelSpec } from '../modelTypes';

/**
 * LM Studio uses dynamic model discovery via /v1/models endpoint
 * Models are loaded by the user and can vary
 * No static model list needed - adapter queries server for available models
 */

/**
 * Create a dynamic model spec from LM Studio model data
 * Used when models are discovered from the server
 */
export function createLMStudioModelSpec(
  modelId: string,
  contextWindow?: number,
  maxTokens?: number
): ModelSpec {
  return {
    provider: 'lmstudio',
    name: modelId,
    apiName: modelId,
    contextWindow: contextWindow || 4096,
    maxTokens: maxTokens || 2048,
    inputCostPerMillion: 0, // Local models are free
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: detectVisionSupport(modelId),
      supportsFunctions: detectToolSupport(modelId),
      supportsStreaming: true,
      supportsThinking: false
    }
  };
}

/**
 * Detect if a model supports vision based on common name patterns
 */
function detectVisionSupport(modelId: string): boolean {
  const visionKeywords = ['vision', 'llava', 'bakllava', 'cogvlm', 'yi-vl', 'moondream'];
  const lowerModelId = modelId.toLowerCase();
  return visionKeywords.some(keyword => lowerModelId.includes(keyword));
}

/**
 * Detect if a model supports tool/function calling based on common name patterns
 * Many newer models support function calling
 *
 * Note: Models with "nexus" or "tools-sft" use [TOOL_CALLS] content format
 */
function detectToolSupport(modelId: string): boolean {
  const toolSupportedKeywords = [
    'gpt', 'mistral', 'mixtral', 'hermes', 'nous', 'qwen',
    'deepseek', 'dolphin', 'functionary', 'gorilla',
    // Fine-tuned models with [TOOL_CALLS] format
    'nexus', 'tools-sft', 'tool-calling'
  ];
  const lowerModelId = modelId.toLowerCase();
  return toolSupportedKeywords.some(keyword => lowerModelId.includes(keyword));
}

/**
 * Common LM Studio model families and their typical characteristics
 * Used for display purposes and capability hints
 */
export const LM_STUDIO_MODEL_FAMILIES = {
  llama: {
    name: 'Llama',
    description: 'Meta\'s Llama models - general purpose, high quality',
    typical: {
      contextWindow: 4096,
      supportsJSON: true,
      supportsFunctions: true
    }
  },
  mistral: {
    name: 'Mistral',
    description: 'Mistral AI models - efficient and capable',
    typical: {
      contextWindow: 8192,
      supportsJSON: true,
      supportsFunctions: true
    }
  },
  phi: {
    name: 'Phi',
    description: 'Microsoft Phi models - compact and efficient',
    typical: {
      contextWindow: 2048,
      supportsJSON: true,
      supportsFunctions: false
    }
  },
  qwen: {
    name: 'Qwen',
    description: 'Alibaba Qwen models - multilingual and capable',
    typical: {
      contextWindow: 8192,
      supportsJSON: true,
      supportsFunctions: true
    }
  },
  deepseek: {
    name: 'DeepSeek',
    description: 'DeepSeek models - coding and reasoning focused',
    typical: {
      contextWindow: 16384,
      supportsJSON: true,
      supportsFunctions: true
    }
  }
};

/**
 * Get model family information if available
 */
export function getModelFamily(modelId: string): (typeof LM_STUDIO_MODEL_FAMILIES)[keyof typeof LM_STUDIO_MODEL_FAMILIES] | undefined {
  const lowerModelId = modelId.toLowerCase();

  for (const [familyKey, familyInfo] of Object.entries(LM_STUDIO_MODEL_FAMILIES)) {
    if (lowerModelId.includes(familyKey)) {
      return familyInfo;
    }
  }

  return null;
}
