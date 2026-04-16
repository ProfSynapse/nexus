/**
 * toolCallId - Synthesize tool_call ids for providers that don't supply one.
 *
 * Location: src/services/llm/utils/toolCallId.ts
 *
 * Used by:
 * - src/services/llm/adapters/BaseAdapter.ts (streaming accumulator)
 * - src/services/llm/adapters/shared/ReasoningPreserver.ts (assistant msg builder)
 * - src/services/chat/builders/OpenAIContextBuilder.ts (continuation + append)
 * - src/services/llm/core/ProviderMessageBuilder.ts (Codex branch)
 *
 * Why this exists:
 *   Some providers (notably Azure via OpenRouter) reject requests whose
 *   function_call / function_call_output items have missing or non-OpenAI
 *   call_ids. We therefore synthesize an id whenever the upstream didn't
 *   supply one, and we always emit a `call_*`-prefixed string so that
 *   OpenAIContextBuilder's foreign-id check (`/^call_/`) recognizes the
 *   synthesized id as already-valid and does not renormalize it.
 *
 * Why randomUUID:
 *   The previous pattern `${Date.now()}_${index}` could collide within a
 *   single millisecond across concurrent requests. `crypto.randomUUID()`
 *   eliminates that collision class. When unavailable (very old runtimes),
 *   we fall back to `Date.now()` + a short Math.random tail — still better
 *   than the raw index-based scheme.
 */

/**
 * Synthesize a unique tool_call id when the provider didn't supply one.
 * Always returns an OpenAI-compatible `call_*` id so OpenAI/Azure/OpenRouter
 * accept it without renormalization.
 *
 * @param prefix optional discriminator appended after `call_synth_` for
 *               readability/debuggability (e.g., 'continuation', 'append',
 *               'codex'). No prefix produces `call_synth_{id}`.
 */
export function synthesizeToolCallId(prefix?: string): string {
  // Prefer crypto.randomUUID() — eliminates Date.now() collision class.
  // Fallback for older runtimes uses Date.now() + Math.random().
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = cryptoObj?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `call_synth_${prefix}_${id}` : `call_synth_${id}`;
}
