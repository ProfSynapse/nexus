/**
 * Image and video model ids that providers have shut down or scheduled for
 * shutdown, each with the successor the provider documents.
 *
 * The catalogs no longer offer these ids, but saved settings, per-conversation
 * settings, saved prompts and agent tool calls can still name them. Everything
 * that turns a stored or caller-supplied id into a request runs it through the
 * resolvers here, so an old id keeps working on its successor instead of
 * failing on the shutdown date.
 *
 * Sources:
 * - https://ai.google.dev/gemini-api/docs/deprecations
 * - https://developers.openai.com/api/docs/deprecations
 * - OpenRouter's /api/v1/images/models descriptions for gpt-5-image and
 *   gpt-5-image-mini, which name GPT Image 1 and GPT Image 1 Mini as the image
 *   models underneath.
 */

import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { getVideoModel, type VideoProvider } from './VideoTypes';

export type ImageModelProvider = 'google' | 'openrouter' | 'openai';

export interface RetiredModel {
  /** The id that was retired. */
  id: string;
  /** The provider-documented successor, on the same provider. */
  replacement: string;
  /** Shutdown date (YYYY-MM-DD), past or scheduled. */
  shutdown: string;
}

interface RetiredImageModelEntry {
  replacement: string;
  shutdown: string;
  /** Providers whose catalog offered this id and also offers the replacement. */
  providers: ImageModelProvider[];
}

// Image ids are provider-neutral internal ids, so one entry covers every
// provider that served the id.
const RETIRED_IMAGE_MODELS: Readonly<Record<string, RetiredImageModelEntry>> = {
  'gpt-image-1': { replacement: 'gpt-image-2.5-sunburst', shutdown: '2026-10-23', providers: ['openai'] },
  'gpt-image-1.5': { replacement: 'gpt-image-2.5-sunburst', shutdown: '2026-12-01', providers: ['openai'] },
  'gpt-image-1-mini': { replacement: 'gpt-image-2.5-flare', shutdown: '2026-12-01', providers: ['openai'] },
  'gemini-2.5-flash-image': { replacement: 'gemini-3.1-flash-lite-image', shutdown: '2027-03-15', providers: ['google', 'openrouter'] },
  'gemini-3.1-flash-image-preview': { replacement: 'gemini-nano-banana-2.1', shutdown: '2026-06-25', providers: ['google', 'openrouter'] },
  'gemini-3-pro-image-preview': { replacement: 'gemini-3-pro-image', shutdown: '2026-06-25', providers: ['google', 'openrouter'] },
  // OpenRouter-only chat image models built on GPT Image 1 / GPT Image 1 Mini.
  'gpt-5-image': { replacement: 'gpt-image-2.5-sunburst', shutdown: '2026-10-23', providers: ['openrouter'] },
  'gpt-5-image-mini': { replacement: 'gpt-image-2.5-flare', shutdown: '2026-12-01', providers: ['openrouter'] },
};

const GEMINI_OMNI = 'gemini-omni-1.1-flash';

// Video ids are provider-scoped. Every Google-direct id below names
// gemini-omni-1.1-flash as its replacement on the deprecations page (the Veo
// 3.0/2.0 GA ids name the Veo 3.1 previews, which in turn name Omni).
const RETIRED_VIDEO_MODELS: Readonly<Partial<Record<VideoProvider, Readonly<Record<string, Omit<RetiredModel, 'id'>>>>>> = {
  google: {
    'veo-3.1-generate-preview': { replacement: GEMINI_OMNI, shutdown: '2026-10-22' },
    'veo-3.1-fast-generate-preview': { replacement: GEMINI_OMNI, shutdown: '2026-10-22' },
    'veo-3.1-lite-generate-preview': { replacement: GEMINI_OMNI, shutdown: '2026-10-22' },
    'gemini-omni-flash-preview': { replacement: GEMINI_OMNI, shutdown: '2026-10-22' },
    'veo-3.0-generate-001': { replacement: GEMINI_OMNI, shutdown: '2026-06-30' },
    'veo-3.0-fast-generate-001': { replacement: GEMINI_OMNI, shutdown: '2026-06-30' },
    'veo-2.0-generate-001': { replacement: GEMINI_OMNI, shutdown: '2026-06-30' },
  },
};

/** The retirement record for an image id on a provider, or undefined when the id is current. */
export function getRetiredImageModel(provider: string | undefined, model: string | undefined): RetiredModel | undefined {
  if (!provider || !model) return undefined;
  const entry = Object.prototype.hasOwnProperty.call(RETIRED_IMAGE_MODELS, model) ? RETIRED_IMAGE_MODELS[model] : undefined;
  if (!entry || !entry.providers.includes(provider as ImageModelProvider)) return undefined;
  return { id: model, replacement: entry.replacement, shutdown: entry.shutdown };
}

/** The retirement record for a video id on a provider, or undefined when the id is current. */
export function getRetiredVideoModel(provider: string | undefined, model: string | undefined): RetiredModel | undefined {
  if (!provider || !model) return undefined;
  const table = RETIRED_VIDEO_MODELS[provider as VideoProvider];
  const entry = table && Object.prototype.hasOwnProperty.call(table, model) ? table[model] : undefined;
  return entry ? { id: model, ...entry } : undefined;
}

/** The provider that served a retired video id, for calls that name a model without a provider. */
export function findRetiredVideoModelProvider(model: string | undefined): VideoProvider | undefined {
  if (!model) return undefined;
  for (const [provider, table] of Object.entries(RETIRED_VIDEO_MODELS)) {
    if (table && Object.prototype.hasOwnProperty.call(table, model)) return provider as VideoProvider;
  }
  return undefined;
}

/** The sentence a caller sees when a retired id was swapped for its successor. */
export function describeRetiredModelSubstitution(retired: RetiredModel): string {
  return `Model "${retired.id}" was retired by its provider (shutdown ${retired.shutdown}); used its replacement "${retired.replacement}" instead.`;
}

/** Every retired image id, for tests and diagnostics. */
export function listRetiredImageModels(): Array<RetiredModel & { providers: ImageModelProvider[] }> {
  return Object.entries(RETIRED_IMAGE_MODELS).map(([id, entry]) => ({ id, ...entry, providers: [...entry.providers] }));
}

/** Every retired video id with its provider, for tests and diagnostics. */
export function listRetiredVideoModels(): Array<RetiredModel & { provider: VideoProvider }> {
  return Object.entries(RETIRED_VIDEO_MODELS).flatMap(([provider, table]) =>
    Object.entries(table ?? {}).map(([id, entry]) => ({ id, provider: provider as VideoProvider, ...entry }))
  );
}

/**
 * Point saved image and video defaults that name a retired id at the
 * documented successor, in place. Returns whether anything changed.
 *
 * Runs on every settings load, in memory only. It never writes data.json on
 * its own: the stored value is left for the user's next edit of that setting,
 * so a synced device still on an older plugin version keeps reading an id it
 * knows. The video aspect ratio and resolution are kept when the successor
 * supports them and fall back to its defaults otherwise.
 */
export function normalizeRetiredMediaDefaults(llmProviders: LLMProviderSettings | undefined): boolean {
  if (!llmProviders) return false;
  let changed = false;

  const image = llmProviders.defaultImageModel;
  const retiredImage = getRetiredImageModel(image?.provider, image?.model);
  if (image && retiredImage) {
    llmProviders.defaultImageModel = { ...image, model: retiredImage.replacement };
    changed = true;
  }

  const video = llmProviders.defaultVideoModel;
  const retiredVideo = getRetiredVideoModel(video?.provider, video?.model);
  if (video && retiredVideo) {
    const successor = getVideoModel(video.provider, retiredVideo.replacement);
    llmProviders.defaultVideoModel = {
      ...video,
      model: retiredVideo.replacement,
      aspectRatio: successor && video.aspectRatio && !successor.aspectRatios.includes(video.aspectRatio)
        ? successor.defaultAspectRatio
        : video.aspectRatio,
      resolution: successor && video.resolution && !successor.resolutions.includes(video.resolution)
        ? successor.defaultResolution
        : video.resolution,
    };
    changed = true;
  }

  return changed;
}
