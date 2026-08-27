/**
 * Groq Model Specifications
 * Updated August 2026 against Groq's live /models listing — pruned Llama 4
 * Scout/Maverick, Llama Guard 4, DeepSeek R1 Distill and Qwen 3 32B (no longer
 * served); refreshed GPT OSS pricing and output limits; added Qwen 3.6/3.8 27B.
 *
 * Groq provides ultra-fast inference with OpenAI-compatible API
 * Specializes in high-performance LLM serving with extended usage metrics
 */

import { ModelSpec } from '../modelTypes';

export const GROQ_MODELS: ModelSpec[] = [
  // OpenAI models on Groq
  {
    provider: 'groq',
    name: 'GPT OSS 20B',
    apiName: 'openai/gpt-oss-20b',
    contextWindow: 131072,
    maxTokens: 65536,
    inputCostPerMillion: 0.075,
    outputCostPerMillion: 0.30,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'groq',
    name: 'GPT OSS 120B',
    apiName: 'openai/gpt-oss-120b',
    contextWindow: 131072,
    maxTokens: 65536,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.60,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Qwen models on Groq
  {
    provider: 'groq',
    name: 'Qwen 3.6 27B',
    apiName: 'qwen/qwen3.6-27b',
    contextWindow: 131072,
    maxTokens: 16384,
    inputCostPerMillion: 0.60,
    outputCostPerMillion: 3.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  // Qwen 3.8 27B is held back until Groq lifts its preview rate limits: on
  // 2026-08-27 the key's per-model allocation was 8,000 tokens/min and 1,000
  // requests/day (vs 250k TPM for the other models) — below what a single
  // Nexus chat request needs. Id, metadata and a live call are verified;
  // re-enable when the x-ratelimit headers show a production tier.
  // Context window of 131,042 is Groq's own declared figure (their model
  // page and /models endpoint agree), not a typo for 131,072.
  // {
  //   provider: 'groq',
  //   name: 'Qwen 3.8 27B',
  //   apiName: 'qwen/qwen3.8-27b',
  //   contextWindow: 131042,
  //   maxTokens: 16384,
  //   inputCostPerMillion: 0.80,
  //   outputCostPerMillion: 4.00,
  //   capabilities: {
  //     supportsJSON: true,
  //     supportsImages: true,
  //     supportsFunctions: true,
  //     supportsStreaming: true,
  //     supportsThinking: true
  //   }
  // }
];

export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';

/**
 * Groq-specific model categories for easier selection
 */
export const GROQ_MODEL_CATEGORIES = {
  // Ultra-fast text generation
  FAST_TEXT: [
    'openai/gpt-oss-20b'
  ],

  // High-quality text generation
  QUALITY_TEXT: [
    'openai/gpt-oss-120b'
  ],

  // Reasoning-optimized
  REASONING: [
    'openai/gpt-oss-120b',
    'qwen/qwen3.6-27b'
  ],

  // Vision-capable
  VISION: [
    'qwen/qwen3.6-27b'
  ]
};

/**
 * Get models by category
 */
export function getGroqModelsByCategory(category: keyof typeof GROQ_MODEL_CATEGORIES): ModelSpec[] {
  const modelNames = GROQ_MODEL_CATEGORIES[category];
  return GROQ_MODELS.filter(model => modelNames.includes(model.apiName));
}

/**
 * Check if a model supports specific capabilities
 */
export function getGroqModelCapabilities(modelName: string): ModelSpec['capabilities'] | null {
  const model = GROQ_MODELS.find(m => m.apiName === modelName);
  return model?.capabilities || null;
}
