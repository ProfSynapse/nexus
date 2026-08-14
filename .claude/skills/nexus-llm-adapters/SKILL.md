---
name: nexus-llm-adapters
description: Nexus LLM provider adapter invariants — streaming, in-stream error frames, reasoning/thinking rendering, local-model quirks (LM Studio, Ollama), CLI-backed providers, and shared transcription. Use when adding or debugging a provider adapter, working on streaming or reasoning display, or touching chat message/branch plumbing.
---

# Nexus LLM Adapters

Providers talk direct HTTP via `ProviderHttpClient` — the vendor SDKs were removed
deliberately. Adapters live in `src/services/llm/adapters/{provider}/`, over
`BaseAdapter`.

## Streaming: in-stream error frames

Some providers (notably LM Studio) return `{"error":{...}}` frames **over HTTP
200**. Without handling, the stream simply ends empty and the user sees a blank
bubble with no error.

`SSEStreamOptions.extractError` + `processNodeStream` in `BaseAdapter.ts` turn those
frames into `LLMProviderError(..., 'PROVIDER_STREAM_ERROR')`.

**Any new streaming adapter should wire `extractError`.** An empty stream is not an
acceptable failure mode.

## Reasoning / thinking rendering

The path is: `chunk.reasoning` → `onReasoningUpdate(messageId, text, isComplete)` on
`StreamHandlerEvents`/`MessageManagerEvents` → a collapsible
`<details class="message-reasoning">` block that auto-expands while streaming and
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

**`ensureModelLoaded` never compares `flash_attention`.** It is passed through, but
comparing it caused infinite model reloads: it is llama.cpp-only, and MLX no-ops it
without reporting it back, so the comparison never converged. Keep `parallel: 1` in
the load body — LM Studio honours it despite its absence from the public REST docs,
and MLX speculative needs a non-batched instance.

**Reasoning level for local models is deliberately not wired.** `renderReasoningControls`
gates on `staticModelsService.findModel`, which has no `lmstudio`/`ollama` case;
adapters don't send a level (`OllamaAdapter` sends `think:<boolean>`, LM Studio sends
no `reasoning_effort`); `ThinkingEffortMapper` has no entries for either. **Decision:
users set reasoning effort in LM Studio's own UI.** Do not build this speculatively.

## CLI-backed providers: Antigravity (`agy`)

The `google-gemini-cli` provider id is unchanged for settings compatibility, but the
runtime is `agy`, not the deprecated `gemini` CLI. Contract:

- Emits **plain text** — no JSON output mode
- Reports **no token usage**
- `--model` takes human labels and **fails open** on an unknown slug, so
  `geminiCliModelNormalize.ts` is a **fail-closed allowlist** — keep it that way
- Ignores `GEMINI_CLI_SYSTEM_SETTINGS_PATH`

Security constraints, non-negotiable: the auth probe is a **boolean-only** presence
check over `~/.gemini/oauth_creds.json` — never read, log, or return the token; no
persistent `~/.gemini` writes; no `--dangerously-skip-permissions`.

## Shared transcription

Shared service: `src/services/llm/TranscriptionService.ts`. Types:
`src/services/llm/types/VoiceTypes.ts`.

Providers with word-level timestamps: **OpenAI** (`verbose_json`), **Groq**,
**Mistral** (+diarization), **Deepgram** (+utterances, diarization, keyword
biasing), **AssemblyAI** (+speaker labels).

⚠️ The ingest shim at
`src/agents/ingestManager/tools/services/TranscriptionService.ts` **strips
word-level data**. Callers needing word timings must use the shared service
directly.

**Drag-drop paths:** browser `File.name` is a basename only — recover the
vault-relative path with `vault.getFiles().find(f => f.name === file.name)` in
`handleIngestFiles`.

## Chat branches

A branch **is** a conversation with parent metadata:

- `metadata.parentConversationId` — parent conversation
- `metadata.parentMessageId` — the message it attaches to
- `metadata.branchType` — `'alternative' | 'subagent'`

Key files: `src/services/chat/BranchService.ts` (facade over ConversationService),
`src/ui/chat/controllers/SubagentController.ts`,
`src/ui/chat/services/ContextTracker.ts` (token/cost tracking).

Subagents: branch → stream via LLMService → save result. `chunk.toolCalls` are
display-only.

## Chat UI touchpoints

Chat view is `src/ui/chat/ChatView.ts` — conversations, branching, streaming, tool
accordion. Suggesters live in `src/ui/chat/components/suggesters/` (TextArea and
ContentEditable variants, wired in `initializeSuggesters.ts`):

| Trigger | Purpose |
|---|---|
| `/` | Tool hints |
| `@` | Custom agents / prompts |
| `[[` | Note links |
| `#` | Workspace data |

Prompt assembly: `src/ui/chat/services/MessageEnhancer.ts` and
`SystemPromptBuilder.ts`.

**WebLLM / Nexus Quark** (in-browser model, 4B, 4K context, `<tool_call>` format):
multi-turn tool continuations may crash on Apple Silicon via WebGPU. If startup
hangs on "loading cache", clear site data.

## Model definitions

Adding or changing model metadata (ids, pricing, context windows, capabilities,
defaults) is the `nexus-model-updates` skill, which includes the live provider
smoke test. Grading models on tool use is `nexus-model-eval`.
