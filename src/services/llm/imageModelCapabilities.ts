/**
 * What each image model can do, read from the adapter catalogs without
 * constructing an adapter. The generateImage tool builds its schema from this,
 * filtered to the providers that have a key, so an agent is only told about
 * parameters and limits it can actually use.
 *
 * A new model's capabilities belong on its catalog entry. Nothing that reads
 * this module should name a model.
 */

import { GEMINI_IMAGE_MODEL_SPECS } from './adapters/google/GeminiImageAdapter';
import { MAX_REFERENCE_IMAGES, OPENAI_IMAGE_ASPECT_RATIOS, OPENAI_IMAGE_MODEL_SPECS } from './adapters/openai/OpenAIImageAdapter';
import { OPENROUTER_IMAGE_MODEL_SPECS } from './adapters/openrouter/OpenRouterImageAdapter';
import type { ImageModelFeatures, ImageProvider, NanoBananaImageSize } from './types/ImageTypes';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';

export interface ImageModelCapability {
  provider: ImageProvider;
  id: string;
  features: ImageModelFeatures;
  /** Empty when the model takes no resolution (it is sized in pixels or fixed). */
  imageSizes: NanoBananaImageSize[];
  maxReferenceImages: number;
  aspectRatios: readonly string[];
}

const IMAGE_PROVIDERS: ImageProvider[] = ['google', 'openai', 'openrouter'];

/** Wire values use '512'; the imageSize parameter calls it '512px'. */
function toImageSize(wire: string): NanoBananaImageSize {
  return (wire === '512' ? '512px' : wire) as NanoBananaImageSize;
}

function capabilitiesFor(provider: ImageProvider): ImageModelCapability[] {
  switch (provider) {
    case 'google':
      return Object.entries(GEMINI_IMAGE_MODEL_SPECS).map(([id, spec]) => ({
        provider,
        id,
        features: {},
        imageSizes: spec.imageSizes.map(toImageSize),
        maxReferenceImages: spec.maxReferenceImages,
        aspectRatios: spec.aspectRatios
      }));
    case 'openai':
      return Object.entries(OPENAI_IMAGE_MODEL_SPECS).map(([id, spec]) => ({
        provider,
        id,
        features: spec.features ?? {},
        imageSizes: [],
        maxReferenceImages: MAX_REFERENCE_IMAGES,
        aspectRatios: OPENAI_IMAGE_ASPECT_RATIOS
      }));
    case 'openrouter':
      return Object.entries(OPENROUTER_IMAGE_MODEL_SPECS).map(([id, spec]) => ({
        provider,
        id,
        features: spec.features ?? {},
        imageSizes: (spec.resolutions ?? []).map(toImageSize),
        maxReferenceImages: spec.maxReferenceImages,
        aspectRatios: spec.aspectRatios
      }));
  }
}

/** Providers that can serve images right now: a key is set and the provider is on. */
export function getConfiguredImageProviders(settings: LLMProviderSettings | null | undefined): ImageProvider[] {
  return IMAGE_PROVIDERS.filter(provider => {
    const config = settings?.providers?.[provider];
    return !!config?.apiKey && !!config.enabled;
  });
}

export function listImageModelCapabilities(providers: readonly ImageProvider[]): ImageModelCapability[] {
  return IMAGE_PROVIDERS.filter(provider => providers.includes(provider)).flatMap(capabilitiesFor);
}
