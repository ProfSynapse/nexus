/**
 * Provider Error Messages
 * Location: src/services/llm/adapters/shared/ProviderErrorMessages.ts
 *
 * Turns a provider's HTTP failure into a sentence a person can act on. The raw
 * operation, status and provider text stay on ProviderHttpError for logs.
 *
 * Used by: ProviderHttpError
 */
import { PROVIDER_NAMES } from '../../providers/providerDisplayNames';

/**
 * Statuses a provider uses to say it is out of capacity right now: 503 across
 * providers, 529 for Anthropic's overloaded_error. The request was refused
 * before any generation, so it is safe to send again.
 */
export const OVERLOADED_STATUSES: readonly number[] = [503, 529];

/** Pull "retry in 27.5s" (Google's quota wording) out of a provider message. */
function retryHint(detail: string): string {
  const match = /retry in ([\d.]+)\s*s/i.exec(detail);
  const seconds = match ? Math.ceil(Number(match[1])) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
    : 'Wait a minute and try again.';
}

function withDetail(sentence: string, detail: string): string {
  return detail ? `${sentence}: ${detail}` : `${sentence}.`;
}

/** The status line shown while an overloaded request waits: "Google AI is overloaded. Retrying 2/4…" */
export function describeOverloadRetry(provider: string | undefined, retry: number, maxRetries: number): string {
  const name = (provider && PROVIDER_NAMES[provider]) || 'The AI provider';
  return `${name} is overloaded. Retrying ${retry}/${maxRetries}…`;
}

/** Wordings providers use for a valid key that lacks access. Each carries the permission when it names one. */
const MISSING_PERMISSION_PATTERNS: readonly RegExp[] = [
  /missing (?:the )?permissions?:?\s+([\w.:-]+)/i,
  /missing scopes?:\s*([\w.:,\s-]+?)(?:\.\s|\.$|$)/i,
  /insufficient (?:\w+ )?(?:permissions?|scopes?)/i,
  /does not have permission/i,
  /lacks? (?:the )?(?:required )?(?:permissions?|scopes?)/i,
  /permission_denied|permission denied/i,
];

/**
 * Tell a key that lacks a permission apart from a key that is simply wrong. They
 * need opposite fixes: replacing a good key does nothing. Returns the permission
 * the provider named ('' when it named none), or null when this is not a
 * permission failure. Only auth statuses count, so a rejected request that merely
 * mentions permissions is not misreported.
 */
export function findMissingPermission(status: number, detail: string): string | null {
  if (status !== 401 && status !== 403) return null;
  for (const pattern of MISSING_PERMISSION_PATTERNS) {
    const match = pattern.exec(detail);
    if (match) return (match[1] ?? '').trim();
  }
  return null;
}

/** Apps keep their keys in a different settings tab from providers. */
function keySettingsLocation(provider: string): string {
  return provider === 'elevenlabs' ? 'Apps' : 'Providers';
}

export function describeProviderHttpFailure(provider: string, status: number, detail: string): string {
  // Image adapters report as `openai-image`, but people know the provider.
  const providerId = provider.replace(/-image$/, '');
  const name = PROVIDER_NAMES[providerId] ?? 'The AI provider';
  const missingPermission = findMissingPermission(status, detail);

  let sentence: string;
  if (missingPermission !== null) {
    const which = missingPermission ? `the ${missingPermission} permission` : 'a permission this needs';
    sentence = `${name} accepted the API key, but it is missing ${which}. ` +
      `Add it to the key in your ${name} account, or use a key that has it. Replacing the key with the same access will not help.`;
  } else if (OVERLOADED_STATUSES.includes(status)) {
    sentence = `${name} is overloaded right now. Wait a moment and try again, or switch to a different model.`;
  } else if (status === 429) {
    sentence = `${name} says you have hit a rate limit or usage quota. ${retryHint(detail)} ` +
      'If this keeps happening, check your plan and usage limits with the provider.';
  } else if (status === 401) {
    sentence = `${name} did not accept the API key. Check it in Nexus settings under ${keySettingsLocation(providerId)}.`;
  } else if (status === 403) {
    sentence = withDetail(`${name} refused access to this model`, detail);
  } else if (status === 404) {
    sentence = `${name} could not find this model. It may be retired or unavailable to your account; choose another model.`;
  } else if (status === 408 || status === 504) {
    sentence = `${name} took too long to respond. Try again.`;
  } else if (status >= 500) {
    sentence = `${name} had a server error. Try again in a moment.`;
  } else if (status >= 400) {
    // Bad requests are the one case where the provider's own words are the fix.
    sentence = withDetail(`${name} rejected the request`, detail);
  } else {
    sentence = withDetail(`${name} returned an unexpected response`, detail);
  }

  return `${sentence} (HTTP ${status})`;
}
