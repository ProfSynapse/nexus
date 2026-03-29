/**
 * Location: src/agents/ingestManager/tools/services/VisionMessageFormatter.ts
 * Purpose: Format base64 PNG images into provider-specific vision message formats.
 * Supports 4 provider families: OpenAI-style, Anthropic, Google, Ollama.
 *
 * Used by: OcrService
 * Dependencies: types (VisionProviderFamily, VisionMessage)
 */

import { VisionProviderFamily, VisionMessage } from '../../types';

/** Map provider names to their vision format family */
const PROVIDER_FAMILY_MAP: Record<string, VisionProviderFamily> = {
  openai: 'openai',
  'openai-codex': 'openai',
  'github-copilot': 'openai',
  groq: 'openai',
  openrouter: 'openai',
  mistral: 'openai',
  requesty: 'openai',
  lmstudio: 'openai',
  anthropic: 'anthropic',
  'anthropic-claude-code': 'anthropic',
  google: 'google',
  'google-gemini-cli': 'google',
  ollama: 'ollama',
};

/**
 * Determine the vision message format family for a given provider.
 * Defaults to 'openai' for unknown providers (most common format).
 */
export function getProviderFamily(providerName: string): VisionProviderFamily {
  return PROVIDER_FAMILY_MAP[providerName] || 'openai';
}

/**
 * Build a vision message with a base64 PNG image and text prompt,
 * formatted for the specified provider family.
 */
export function formatVisionMessage(
  base64Png: string,
  prompt: string,
  providerFamily: VisionProviderFamily
): VisionMessage {
  switch (providerFamily) {
    case 'openai':
      return formatOpenAIVision(base64Png, prompt);
    case 'anthropic':
      return formatAnthropicVision(base64Png, prompt);
    case 'google':
      return formatGoogleVision(base64Png, prompt);
    case 'ollama':
      return formatOllamaVision(base64Png, prompt);
  }
}

/**
 * OpenAI-style vision format.
 * Used by: OpenAI, Groq, OpenRouter, Mistral, LM Studio, Copilot, Codex, Requesty
 */
function formatOpenAIVision(base64Png: string, prompt: string): VisionMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${base64Png}` },
      },
      {
        type: 'text',
        text: prompt,
      },
    ],
  };
}

/**
 * Anthropic vision format.
 * Uses type: "image" with source.type: "base64", raw base64 (no data: prefix).
 */
function formatAnthropicVision(base64Png: string, prompt: string): VisionMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: base64Png,
        },
      },
      {
        type: 'text',
        text: prompt,
      },
    ],
  };
}

/**
 * Google (Gemini) vision format.
 * Uses parts array with inline_data for images.
 */
function formatGoogleVision(base64Png: string, prompt: string): VisionMessage {
  return {
    role: 'user',
    content: [
      {
        inline_data: {
          mime_type: 'image/png',
          data: base64Png,
        },
      },
      {
        text: prompt,
      },
    ],
  };
}

/**
 * Ollama vision format.
 * Uses images[] array directly on message, content is plain string.
 */
function formatOllamaVision(base64Png: string, prompt: string): VisionMessage {
  return {
    role: 'user',
    content: prompt,
    images: [base64Png],
  };
}
