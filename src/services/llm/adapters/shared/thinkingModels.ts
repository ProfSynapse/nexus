/**
 * Shared reasoning/thinking-model heuristics for local providers (LM Studio, Ollama).
 *
 * This name match drives two things:
 *   1. the `supportsThinking` capability flag (so the UI offers the thinking toggle), and
 *   2. Ollama's default `think` request value (LM Studio needs no request param).
 *
 * Rendering of reasoning does NOT depend on this heuristic — each adapter routes its
 * provider's native reasoning field (LM Studio `reasoning_content`, Ollama
 * `message.thinking`) to the shared StreamChunk.reasoning channel whenever it appears.
 * The heuristic only affects defaults/capability display, so a miss degrades gracefully.
 */
export function isThinkingModelName(modelId: string): boolean {
  const lower = (modelId || '').toLowerCase();
  return /(?:^|[-/_.])(?:r1|qwq|thinking|reasoner?|reasoning|magistral|cogito|smallthinker)|deepseek-r1|qwen3/.test(lower);
}
