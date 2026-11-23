import { Platform } from 'obsidian';

/** Whether a provider should receive explicit tool schemas in chat flows. */
export function shouldPassToolSchemasToProvider(providerId?: string | null): boolean {
  return Boolean(providerId) && providerId !== 'webllm' && !isTextOnlyProvider(providerId);
}

/** Antigravity's Windows print-mode adapter and Perplexity only support text completion. */
export function isTextOnlyProvider(providerId?: string | null): boolean {
  return providerId === 'perplexity' || (providerId === 'google-gemini-cli' && Platform.isWin);
}

/**
 * Perplexity is intentionally limited to text/search behavior in Nexus chat.
 *
 * Deliberate narrow predicate, kept intentionally: it is currently consumer-less
 * in src/ (the text-only seam moved to isTextOnlyProvider), but is retained as a
 * Perplexity-specific check for any future Perplexity-only branch — do NOT
 * broaden it to other providers, and do NOT delete it.
 */
export function isPerplexityProvider(providerId?: string | null): boolean {
  return providerId === 'perplexity';
}
