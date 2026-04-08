const PROVIDERS_WITHOUT_EXPLICIT_TOOL_SCHEMAS = new Set([
  'webllm',
  'perplexity'
]);

/**
 * Return whether a provider should receive explicit tool schemas in chat flows.
 * WebLLM has tool behavior baked into the model, while Perplexity does not
 * support Nexus tool calling at all.
 */
export function shouldPassToolSchemasToProvider(providerId?: string | null): boolean {
  if (!providerId) {
    return false;
  }

  return !PROVIDERS_WITHOUT_EXPLICIT_TOOL_SCHEMAS.has(providerId);
}

/**
 * Perplexity is intentionally limited to text/search behavior in Nexus chat.
 */
export function isPerplexityProvider(providerId?: string | null): boolean {
  return providerId === 'perplexity';
}
