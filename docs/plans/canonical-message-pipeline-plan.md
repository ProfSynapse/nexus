# Canonical Message Pipeline — Scoping Document

**Status:** Proposal
**Author:** Claude (with Joseph)
**Date:** 2026-04-16
**Driver bug:** Azure `Missing required parameter: 'input[N].call_id'` — required 6 separate fixes across 6 layers because each layer has its own message type and remap point.

---

## Problem

Conversation messages flow through ~5 different shapes between storage and the network. Each layer has its own type and its own `.map()` that can drop fields:

```
Storage ChatMessage (camelCase: toolCalls)
  ↓ ChatService loads → ConversationData
  ↓ StreamingResponseService.buildLLMMessages → buildContextForProvider
  ↓   → builders produce LLMMessage[] (OpenAIMessage | AnthropicMessage | GoogleMessage)
  ↓   → .map(m => {role, content, ...}) ← LOSS POINT #1 (fixed)
  ↓ LLMService.generateResponseStream
  ↓   → .map(msg => ConversationMessage) ← LOSS POINT #2 (fixed today)
  ↓ StreamingOrchestrator.generateResponseStream
  ↓ ProviderMessageBuilder.buildContinuationOptions
  ↓   → buildToolContinuation rebuilds again
  ↓ Adapter sends to API
```

**Concrete fields that have caused or could cause bugs:**
| Field | Used by | Lost where (historically) |
|-------|---------|---------------------------|
| `tool_call_id` | OpenAI, OpenRouter, Anthropic | LLMService remap |
| `tool_calls` | All | StreamingResponseService remap |
| `reasoning_details` | Gemini via OpenRouter | (latent risk) |
| `thought_signature` | Gemini via OpenRouter | (latent risk) |
| `name` | OpenAI function role (legacy) | (latent risk) |

---

## Inventory (measured)

- **Source files in scope:** 15 (LLM core + chat + builders)
- **Test files exercising the pipeline:** 14
- **LOC in core pipeline files:** ~3,500
- **Distinct message interfaces:** 7
  - `ChatMessage` (storage, camelCase)
  - `ConversationMessage` (LLM core)
  - `LLMMessage` (union)
  - `OpenAIMessage` / `AnthropicMessage` / `GoogleMessage` (provider-specific)
  - per-adapter local types (`RequestyMessage`, `GroqChatCompletionMessage`, etc. — these are fine, they're at the network boundary)
- **Active `.map()` remap sites between layers:** 8 in `src/services/`

---

## Three Options

### Option A — Patch the remaining latent risks
**Scope:** Audit each remap site for missing fields; add fallthrough preservation for `reasoning_details`, `thought_signature`, `name`.

**Files touched:** 4 (LLMService, StreamingResponseService, BranchService, ConversationTypeConverters)
**LOC change:** ~50
**Risk:** Low — purely additive
**Benefit:** Closes the 3 latent fields. Doesn't fix the architecture. Adding a NEW field later still requires touching all 4 places.

### Option B — Eliminate the LLMService remap (drop one layer)
**Scope:** `LLMService.generateResponseStream` does `.map()` to build `ConversationMessage[]` from input `messages`. The input already comes from `StreamingResponseService.buildLLMMessages` which produces compatible objects. The remap is **redundant** — it just casts types.

Replace with: `LLMService` accepts `ConversationMessage[]` directly; `StreamingResponseService.buildLLMMessages` returns `ConversationMessage[]` instead of `Array<{role, content}>`.

**Files touched:** 4 (LLMService, StreamingResponseService, callers of generateResponseStream, ConversationMessage type widening)
**LOC change:** ~80
**Risk:** Medium — changes a public-ish method signature inside the LLM core
**Benefit:** Removes one entire class of field-loss bugs. The pipeline becomes:
```
buildLLMMessages → ConversationMessage[]
  → LLMService → StreamingOrchestrator (no remap)
  → ProviderMessageBuilder.buildContinuationOptions
  → builders (only conversion happens here)
```

### Option C — Single canonical type + builders are the only converter
**Scope:** Promote `ConversationMessage` (or a new `CanonicalMessage`) to be the ONE type used everywhere between storage and adapter. Define it as the strict superset of fields any provider needs:
```typescript
interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[];
  tool_calls?: NormalizedToolCall[];
  tool_call_id?: string;
  reasoning_details?: ReasoningEntry[];
  thought_signature?: string;
  name?: string;
}
```
- `StreamingResponseService.buildLLMMessages` → returns `CanonicalMessage[]`
- `LLMService` → no remap
- `StreamingOrchestrator` → no remap
- `ProviderMessageBuilder.buildContinuationOptions` → calls builder ONCE
- Builder = `CanonicalMessage[]` → provider-specific format. The ONLY place transformation happens.

Delete: `OpenAIContextBuilder.buildContext` (the storage→OpenAI direct path). Replace with: `ConversationData → CanonicalMessage[]` → `OpenAIBuilder.toOpenAI(canonical[])`. Same for Anthropic, Google.

**Files touched:** 11 (5 builders + 4 core pipeline + 2 tests)
**LOC change:** ~400 (much of it deletion — net negative)
**Risk:** Higher — bigger refactor, more test surface to revalidate
**Benefit:** The pipeline becomes trivially correct by construction. Adding a new field means:
1. Add to `CanonicalMessage`
2. Add to one `*Builder.toProvider()` per provider that uses it

No more 4-place updates, no more silent field drops.

---

## What's actually happening in the codebase RIGHT NOW

After today's fixes:
- **OpenAI/OpenRouter/Azure path: working** — `tool_call_id` flows through all 6 layers correctly
- **Anthropic path: works because Anthropic accepts any string id** — but `AnthropicContextBuilder` doesn't normalize foreign-format ids. If Anthropic ever tightens, switching from OpenAI→Anthropic breaks
- **Mistral path: vulnerable** — Mistral requires strict 9-char alphanumeric ids ([openclaw/openclaw#47707](https://github.com/openclaw/openclaw/issues/47707)). If a user has stored conversations with `call_*` or `toolu_*` ids and switches to Mistral, they'll hit a similar bug
- **Google path: low-risk** — Google pairs by function name not id

Latent fields (`reasoning_details`, `thought_signature`, `name`) are NOT preserved through the LLMService remap. If we ever start a conversation in Gemini and continue in Gemini after a tool call, the `thought_signature` may be lost. We haven't seen a bug yet because the failure mode is silent (degraded reasoning, not an error).

---

## Recommendation

**Phase 1 — NOW (already done):** Ship today's `tool_call_id` fixes.

**Phase 2 — Soon (1 hour):** Do Option A — preserve the other 3 latent fields in the same way we preserved `tool_call_id`. This is a defensive patch that closes known holes without changing structure.

**Phase 3 — Within next sprint (3-5 hours):** Do Option B — delete the LLMService remap. It's redundant and removes the last in-pipeline field-loss site. This is a low-risk, high-value structural cleanup.

**Phase 4 — Optional later (1-2 days):** Do Option C — full canonical type. Makes future provider additions and field additions trivial. Worth doing when adding the next provider (e.g., bedrock direct, vertex AI direct).

---

## Effort & risk summary

| Option | Effort | Risk | Solves architecture? |
|--------|--------|------|---------------------|
| A — patch latent fields | 1h | Low | No |
| B — drop LLMService remap | 3-5h | Medium | Partly |
| C — canonical type | 1-2 days | Higher (requires test pass) | Yes |

The Phase 2 → 3 → 4 sequence is incremental: each phase ships independently and de-risks the next. We don't have to commit to Option C now.
