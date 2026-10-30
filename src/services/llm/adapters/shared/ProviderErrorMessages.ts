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

export function describeProviderHttpFailure(provider: string, status: number, detail: string): string {
  const name = PROVIDER_NAMES[provider] ?? 'The AI provider';

  let sentence: string;
  if (OVERLOADED_STATUSES.includes(status)) {
    sentence = `${name} is overloaded right now. Wait a moment and try again, or switch to a different model.`;
  } else if (status === 429) {
    sentence = `${name} says you have hit a rate limit or usage quota. ${retryHint(detail)} ` +
      'If this keeps happening, check your plan and usage limits with the provider.';
  } else if (status === 401) {
    sentence = `${name} did not accept the API key. Check it in Nexus settings under Providers.`;
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
