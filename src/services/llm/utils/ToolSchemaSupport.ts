const PROVIDERS_WITHOUT_EXPLICIT_TOOL_SCHEMAS = new Set([
  'webllm',
  'perplexity',
  'google-gemini-cli'
]);

/**
 * Providers that are text-completion only in Nexus chat: they cannot call Nexus
 * tools/agents at all, so tool schemas are pointless and any tool the user
 * requests will not run. Distinct from `webllm`, which is ALSO in the
 * no-explicit-schemas set above but for the opposite reason (its tool behavior is
 * baked into the model, so it stays agentic). Keep `webllm` OUT of this set.
 *
 * - `perplexity`: search/text provider, no Nexus tool calling.
 * - `google-gemini-cli` (Antigravity): the `agy --print` surface supports neither
 *   tool/function calling nor streaming (investigation #62/#64/#66). Capability
 *   source of truth lives in GoogleGeminiCliModels.ts (supportsFunctions:false,
 *   supportsStreaming:false); this set is the provider-level seam consumed by the
 *   user-facing warning surfaces.
 */
const TEXT_ONLY_PROVIDERS = new Set([
  'perplexity',
  'google-gemini-cli'
]);

/**
 * Return whether a provider should receive explicit tool schemas in chat flows.
 * WebLLM has tool behavior baked into the model, while Perplexity and the
 * Antigravity CLI provider do not support Nexus tool calling at all.
 */
export function shouldPassToolSchemasToProvider(providerId?: string | null): boolean {
  if (!providerId) {
    return false;
  }

  return !PROVIDERS_WITHOUT_EXPLICIT_TOOL_SCHEMAS.has(providerId);
}

/**
 * Whether the provider is text-completion only — cannot execute Nexus tools or
 * agents. Drives the text-only user warnings (settings notice + runtime guard)
 * and the subagent text-only prompt branch.
 */
export function isTextOnlyProvider(providerId?: string | null): boolean {
  if (!providerId) {
    return false;
  }

  return TEXT_ONLY_PROVIDERS.has(providerId);
}

/**
 * Perplexity is intentionally limited to text/search behavior in Nexus chat.
 */
export function isPerplexityProvider(providerId?: string | null): boolean {
  return providerId === 'perplexity';
}
