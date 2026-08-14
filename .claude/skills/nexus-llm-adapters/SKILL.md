---
name: nexus-llm-adapters
description: Nexus LLM provider adapter invariants — streaming, in-stream error frames, reasoning/thinking rendering, local-model quirks (LM Studio, Ollama), CLI-backed providers, and shared transcription. Use when adding or debugging a provider adapter, working on streaming or reasoning display, or touching chat message/branch plumbing.
---

# Nexus LLM Adapters

Providers talk direct HTTP via `ProviderHttpClient`
(`src/services/llm/adapters/shared/ProviderHttpClient.ts`, reached through
`BaseAdapter.request()` / `requestStream()`) — there are no vendor LLM SDKs in
`package.json`. Adapters live in `src/services/llm/adapters/{provider}/`, over
`BaseAdapter`.

## Streaming: in-stream error frames

Some providers (notably LM Studio) return `{"error":{...}}` frames **over HTTP
200**. Without handling, the stream simply ends empty and the user sees a blank
bubble with no error.

`SSEStreamOptions.extractError` (`src/services/llm/streaming/SSEStreamProcessor.ts`)
+ `BaseAdapter.processNodeStream` turn those frames into
`LLMProviderError(..., 'PROVIDER_STREAM_ERROR')` — the message is recorded, the pump
is drained, then the error is thrown (so no bogus "complete" chunk is emitted).

**Any new streaming adapter should wire `extractError`.** An empty stream is not an
acceptable failure mode.

## Reasoning / thinking rendering

The path is: `chunk.reasoning` → `onReasoningUpdate(messageId, reasoningText, isComplete)`
on `StreamHandlerEvents`/`MessageManagerEvents` → `ChatView` →
`MessageDisplay.updateMessageReasoning` → `MessageBubble.updateReasoning` /
`syncReasoningBlock`, which renders a collapsible
`<details class="message-reasoning">` block (summary `.message-reasoning-summary`
"Thinking", body `.message-reasoning-content`) that auto-expands while streaming and
collapses on completion.

**Do NOT reintroduce a synthetic `reasoning`-type tool call.** That was the previous
mechanism; the tool coordinator never rendered it, so reasoning flowed correctly
through every layer and silently vanished at the final paint.

## Local models

**LM Studio speculative decoding.** A `draft_model` against a batched-MLX target
fails. `LMStudioAdapter` detects the failure (HTTP *or* in-stream) before any real
output, marks the draft incompatible, drops `draft_model`, and retries — so chat
always produces output. Batched MLX bans speculative decoding outright and vision
MLX never supports it; GGUF targets have no such restriction, paired with a
same-family GGUF draft for matching vocab.

**`ensureModelLoaded` never compares `flash_attention`.** It is passed through when
configured, but comparing it caused infinite model reloads: it is llama.cpp-only, and
MLX no-ops it without reporting it back, so the comparison never converged. The
loaded-instance scan matches on `context_length` only (plus `parallel === 1` when a
draft is configured). `parallel: 1` goes in the load body **when a draft model is
configured** — LM Studio honours it despite its absence from the public REST docs,
and MLX speculative needs a non-batched instance. (The whole pre-load is skipped
unless a context length is configured; failures fall back to JIT loading.)

**Reasoning level for local models is deliberately not wired.** `renderReasoningControls`
(`src/components/shared/ChatSettingsRenderer.ts`) bails unless
`staticModelsService.findModel(provider, model)?.capabilities?.supportsThinking` is
true, and `StaticModelsService.getModelsForProvider` has no `lmstudio`/`ollama` case
(falls through to `[]`), so the control never renders for local providers. Adapters
don't send a level either: `OllamaAdapter` sends a top-level `think: <boolean>`
(`shouldEnableThinking` = explicit `options.enableThinking` ?? `isThinkingModelName`)
and `LMStudioAdapter` sends no `reasoning_effort` at all;
`ThinkingEffortMapper` (`src/services/llm/utils/ThinkingEffortMapper.ts`) has entries
only for anthropic / openai / google / groq / deepseek. **Decision: users set
reasoning effort in LM Studio's own UI.** Do not build this speculatively.

## CLI-backed providers: Antigravity (`agy`)

The `google-gemini-cli` provider id is unchanged for settings compatibility
(`GoogleGeminiCliAdapter.name`), but the runtime binary resolved on PATH is `agy`
(`resolveGeminiCliRuntime` in `src/utils/geminiCli.ts`), not the deprecated `gemini`
CLI. Contract:

- Emits **plain text** — `parseAgyOutput` is `stdout.trim()`; no JSON output mode
- Reports **no token usage** (usage omitted, defaults to zero)
- Text-completion only — no tool/function calling through this provider
- `--model` takes human labels and **fails open** on an unknown slug, so
  `geminiCliModelNormalize.ts` is a **fail-closed allowlist**: it composes
  `"<Base label> (<Effort>)"` from a known base slug + the effort slider and throws
  `LLMProviderError` on anything outside `BASE_MODELS` / `KNOWN_AGY_LABELS`. Keep it
  that way. (Only two bases: Gemini 3.5 Flash — Low/Medium/High; Gemini 3.1 Pro —
  Low/High, so a requested Medium clamps *up* to High.)
- Nexus never sets `GEMINI_CLI_SYSTEM_SETTINGS_PATH`; the old temp-settings-file
  mechanism is gone and a test asserts it is absent from the child env

Invocation is `--print --model <label> --print-timeout 60s` with the prompt on stdin,
plus `--sandbox` **only on macOS** (`shouldUseSandbox()` — the sandbox backend is
verified only there; it is additive defense-in-depth, not the floor).
`--print-timeout` takes a Go duration string (`60s`), not milliseconds, and is the
security-load-bearing kill-switch for a headless tool-permission block (nothing can
approve a prompt in print mode). Note the adapter's own comment claiming it is the
*only* bound is now stale: `runCliProcess` also applies a 120s inactivity watchdog
(`DEFAULT_CLI_IDLE_TIMEOUT_MS`) to every CLI child, agy included.

Security constraints, non-negotiable: the auth probe (`GeminiCliAuthService.runAuthProbe`)
is a **boolean-only** presence check over `~/.gemini/oauth_creds.json` — it reads the
file to test for a non-empty `access_token` (tolerant: whole-file parse → per-line
parse → structural regex) and returns only an exitCode; the token value is **never
captured, logged, or returned**. No persistent `~/.gemini` writes; no
`--dangerously-skip-permissions`. `buildGeminiCliEnv` also strips
`GEMINI_API_KEY`/`GOOGLE_*`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from the child env so
agy can only use its own file-based OAuth.

## Shared transcription

Shared service: `src/services/llm/TranscriptionService.ts`. Types:
`src/services/llm/types/VoiceTypes.ts`.

Five providers are wired, each with its own adapter under
`src/services/llm/adapters/{provider}/`:

- **OpenAI** — word timestamps on `whisper-1` only (`verbose_json` +
  `timestamp_granularities[]=word`). `gpt-4o-transcribe-diarize` uses
  `diarized_json` (speaker labels, segment timing, **no** word detail); the
  `gpt-transcribe` generation returns plain JSON with no timing and rejects
  `verbose_json`.
- **Groq** — `verbose_json`, word timestamps on request
- **Mistral** — word timestamps (`timestamp_granularities=word`) + opt-in `diarize`
- **Deepgram** — `utterances` always on, words parsed, opt-in `diarize`
- **AssemblyAI** — words parsed, opt-in `speaker_labels`

⚠️ The ingest shim at
`src/agents/ingestManager/tools/services/TranscriptionService.ts` **strips
word-level data** — it maps each segment down to `{startSeconds, endSeconds, text}`
even though it requests word timestamps. Callers needing word timings must use the
shared service directly.

## Chat branches

A branch **is** a conversation with parent metadata:

- `metadata.parentConversationId` — parent conversation
- `metadata.parentMessageId` — the message it attaches to
- `metadata.branchType` — stored as `'alternative' | 'subagent'`
  (`src/types/chat/ChatTypes.ts`, `src/types/storage/StorageTypes.ts`)

⚠️ **Two vocabularies, don't conflate them.** The *stored* metadata value is
`'alternative' | 'subagent'`, but the *view-layer* union
`BranchType` (`src/types/branch/BranchTypes.ts`) is `'human' | 'subagent'`.
`BranchService.conversationToBranch` (~line 226) collapses the two: anything that
isn't `'subagent'` becomes `'human'` on the `ConversationBranch.type` it returns —
so a stored `'alternative'` surfaces as `'human'` in the UI. The same mapping is in
`ConversationTypeConverters.ts` and `ChatBranchViewCoordinator.ts`. Neither name is
wrong; they belong to different layers.

Key files: `src/services/chat/BranchService.ts` (facade over ConversationService),
`src/ui/chat/controllers/SubagentController.ts`,
`src/ui/chat/services/ContextTracker.ts` (token/cost tracking).

Subagents: branch → stream via LLMService → save result
(`src/services/chat/SubagentExecutor.ts`). The `chunk.toolCalls` the executor sees
are **already-executed** calls carrying their results (the ping-pong ran inside
LLMService) — consume them for display/status only, never re-execute them.

## Chat UI touchpoints

Chat view is `src/ui/chat/ChatView.ts` — conversations, branching, streaming, tool
accordion. Suggesters live in `src/ui/chat/components/suggesters/` (a `BaseSuggester`
with `TextArea*` and ContentEditable variants; `initializeSuggesters.ts` wires the
four `TextArea*` ones):

| Trigger | Regex | Purpose |
|---|---|---|
| `/` | `/^\/(\w*)$/` — start of input only | Tool hints (MCP tools) |
| `@` | `/@(\w*)$/` | Custom prompts |
| `[[` | `/\[\[([^\]]*?)$/` | Note links |
| `#` | `/#(\w*)$/` | Workspaces |

Prompt assembly: `src/ui/chat/services/MessageEnhancer.ts` and
`src/ui/chat/services/SystemPromptBuilder.ts`.

**WebLLM / Nexus Quark** (in-browser model — `nexus-quark-q3.0.5`, Qwen3-1.7B,
4096-token context, native `<tool_call>` format; the adapter also parses
`[TOOL_CALLS]`): multi-turn tool continuations may crash on Apple Silicon via WebGPU
(documented at `src/utils/platform.ts` `supportsWebLLM` and in the `WebLLMAdapter`
header).

## Model definitions

Adding or changing model metadata (ids, pricing, context windows, capabilities,
defaults) is the `nexus-model-updates` skill, which includes the live provider
smoke test. Grading models on tool use is `nexus-model-eval`.
