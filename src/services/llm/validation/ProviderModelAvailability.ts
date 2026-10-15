/**
 * Which of a provider's models it still serves.
 *
 * Providers retire models without notice. A retired model must not stop the
 * provider from being set up; it should only be impossible to turn on. This
 * asks the provider for the models it lists so the provider settings can mark
 * the missing ones.
 *
 * Unknown is never "unavailable": any failure, an unsupported provider, or an
 * empty list returns null, and callers then treat every model as available.
 */

import { ProviderHttpClient } from '../adapters/shared/ProviderHttpClient';

type ModelListBody = {
  data?: Array<{ id?: unknown }>;
  models?: Array<{ name?: unknown }>;
};

type ListRequest = { url: string; headers: Record<string, string> };

const LIST_TIMEOUT_MS = 10000;

function listRequest(providerId: string, apiKey: string): ListRequest | null {
  const bearer = { Authorization: `Bearer ${apiKey}` };
  switch (providerId) {
    // OpenRouter's list is public and needs no key.
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/models', headers: {} };
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: bearer };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=1000',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      };
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        headers: { 'x-goog-api-key': apiKey }
      };
    case 'mistral':
      return { url: 'https://api.mistral.ai/v1/models', headers: bearer };
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/models', headers: bearer };
    case 'deepseek':
      return { url: 'https://api.deepseek.com/models', headers: bearer };
    default:
      return null;
  }
}

/** Ids the provider lists, or null when that cannot be determined. */
export async function fetchListedModelIds(providerId: string, apiKey: string): Promise<Set<string> | null> {
  const request = listRequest(providerId, apiKey.trim());
  if (!request || (providerId !== 'openrouter' && !apiKey.trim())) return null;

  try {
    const response = await ProviderHttpClient.request<ModelListBody>({
      provider: providerId,
      operation: 'List models',
      method: 'GET',
      timeoutMs: LIST_TIMEOUT_MS,
      ...request
    });
    if (response.status < 200 || response.status >= 300) return null;

    const body = response.json ?? {};
    const ids = new Set<string>();
    for (const entry of body.data ?? []) {
      if (typeof entry.id === 'string') ids.add(entry.id);
    }
    // Google names models "models/<id>".
    for (const entry of body.models ?? []) {
      if (typeof entry.name === 'string') ids.add(entry.name.replace(/^models\//, ''));
    }
    return ids.size > 0 ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Providers resolve some aliases they do not list: OpenRouter serves
 * "anthropic/claude-haiku-4-5" but lists "anthropic/claude-haiku-4.5". Dots and
 * hyphens are compared as equal so an alias is not reported missing.
 */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/\./g, '-');
}

export function isModelListed(modelId: string, listed: ReadonlySet<string>): boolean {
  if (listed.has(modelId)) return true;
  const normalized = normalizeModelId(modelId);
  for (const id of listed) {
    if (normalizeModelId(id) === normalized) return true;
  }
  return false;
}
