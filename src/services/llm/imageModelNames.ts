/**
 * Display names of the image generation models, read from each image
 * adapter's model catalog. No adapter is constructed, so this answers before
 * (or without) an API key: the settings summary can say "Nano Banana 2"
 * rather than the raw id `gemini-3.1-flash-image`.
 */

import { GEMINI_IMAGE_MODEL_SPECS } from './adapters/google/GeminiImageAdapter';
import { OPENAI_IMAGE_MODEL_SPECS } from './adapters/openai/OpenAIImageAdapter';
import { OPENROUTER_IMAGE_MODEL_SPECS } from './adapters/openrouter/OpenRouterImageAdapter';
import type { ImageProvider } from './types/ImageTypes';

const CATALOGS: Record<ImageProvider, Readonly<Record<string, { displayName: string }>>> = {
  google: GEMINI_IMAGE_MODEL_SPECS,
  openai: OPENAI_IMAGE_MODEL_SPECS,
  openrouter: OPENROUTER_IMAGE_MODEL_SPECS
};

/** The catalog name of an image model, or undefined when the provider or model is unknown. */
export function getImageModelDisplayName(
  provider: string | null | undefined,
  model: string | null | undefined
): string | undefined {
  if (!provider || !model) return undefined;
  if (!Object.prototype.hasOwnProperty.call(CATALOGS, provider)) return undefined;
  const catalog = CATALOGS[provider as ImageProvider];
  return Object.prototype.hasOwnProperty.call(catalog, model) ? catalog[model].displayName : undefined;
}
