# Native Chat

Nexus includes a full chat interface inside Obsidian — no need to switch to an external app.

---

## Getting Started

1. Configure a provider in **Settings &rarr; Nexus &rarr; Providers**
2. Open chat via the ribbon icon or command palette (**Nexus: Open Nexus Chat**)
3. Start typing — responses stream in real time

For voice and generated-media defaults, also review **Settings &rarr; Nexus &rarr; Defaults**.

---

## Suggesters

Type special characters to trigger context-aware suggestions:

| Trigger | What It Does |
|---------|--------------|
| `/` | Tool hints — browse and insert available tools |
| `@` | Custom prompts — invoke saved prompts |
| `[[` | Note links — reference vault notes inline |
| `#` | Workspace data — pull in workspace context |

---

## Tool Calls

When the AI uses tools during a conversation, you see them as collapsible panels with live streaming results. Each tool call shows the agent, tool name, parameters, and output.

If a model sends malformed tool arguments, Nexus returns an error that lets it correct that call and continue. Calls that already succeeded are not repeated.

After 25 tool calls, Nexus pauses and offers **Continue** or **Stop**. Continue allows the run to carry on; Stop ends it while keeping the work completed so far.

## Thinking and model selection

Reasoning shared by the model appears in one collapsible accordion per reply, including reasoning between tool calls. The header types rotating words with a pulsing icon and silver sweep while the response is being generated, including during tool use. When the response finishes, it becomes **Reasoning** with a brain icon. Tool activity stays in the status bar.

In chat settings or **Settings &rarr; Nexus &rarr; Defaults**, the **Thinking** dropdown appears when the model supports thinking. It offers **Off** plus the levels that model distinguishes, from **Low**, **Medium**, **High**, **Extra high** and **Max**. Nexus maps these choices to the effort levels the provider accepts; some models support only one enabled level. **Creativity** (temperature) is disabled for models that set their own.

Model lists put models with newer published dates first. Your saved model and provider defaults stay selected. Custom or undated models retain their existing order.

Thinking shares the provider's output allowance with the visible answer. Nexus uses the model allowance where the API requires a limit, and leaves optional limits unset unless you supply one. Provider limits still apply.

The accordion starts collapsed. Click its header to expand it; your choice stays in place through updates and completion. Scrolling upward inside the reasoning pauses automatic following. Return to the bottom or press the circular down-arrow to catch up.

If a response finishes but cannot be saved, Nexus keeps it available in memory and offers **Retry save**. This retries storage without repeating the model response or its tools. Save the response before continuing that conversation or closing Obsidian.

Nexus also saves progress while a reply streams, with later checkpoints at most every two seconds. If Obsidian closes mid-reply, the saved progress is recovered as interrupted rather than treated as a finished answer. Tool calls that did not finish are removed from the recovered reply before it is sent back to a model.

Tool results larger than 256 KiB are shortened when saved and included in later conversation history, keeping their first and last 64 KiB. The active continuation receives the full result. Keep important large outputs in vault files when you need the complete content in future turns.

The **Context window** slider sets the budget Nexus uses to track and compact conversation context. It snaps to preset sizes (32K, 64K, 128K, 200K, 350K, 750K and 1M) below the model's maximum, plus the maximum itself. In Defaults, each provider/model pair remembers its own limit, and the default is the model's advertised window. In chat settings, the limit applies to that conversation only. Nexus checks the estimated prompt size before sending and compacts near the selected budget. This does not change the model's thinking effort or output allowance.

Compaction drafts a saved state from the active conversation, including tool arguments, results and failures, together with any previous compaction state. Its starting output allowance is 10% of the selected context window, capped by the model's known output limit and the space needed for instructions, recent turns and a reply. For example, a 32K window starts at about 3.2K tokens; a 4K local window starts at about 400. A smaller selected or runtime-allocated window takes precedence over the model's advertised maximum.

Nexus saves that checkpoint through `memory create-state` before advancing the context boundary. The checkpoint's restoration context, active task, file paths and next steps are included in the next system prompt and survive reopening the chat. The latest two complete exchanges normally remain in the message history; automatic compaction can include them in the checkpoint when an oversized exchange would otherwise prevent sending. The full transcript remains saved. If checkpoint generation, storage or prompt sizing fails, the old context boundary stays in place.

The compacted context also includes a recent timeline of original goal/memory entries from the conversation’s workspace and session, including native-chat tool-call contexts when no separate MCP trace was written. Up to 12 entries appear oldest to newest, with timestamps, tool names and recorded outcomes. This timeline uses at most 5% of the selected context window after reserving the saved state and recent turns; smaller windows receive fewer entries or marked previews. Goals describe intended actions, while outcomes report recorded status. An unavailable lookup is marked and can retain the last matching snapshot.

The AI is explicitly told to search earlier conversation when a detail is missing or uncertain. The `search memory` schema is prioritized after the saved state, even if it was never used before. Recovery instructions narrow to conversation results in the current session and request surrounding turns. Small windows can receive the current catalog’s recovery arguments (query, memory types, session, window and limit); additional options require discovery. Conversation search depends on the conversation index, and an empty or unavailable search must be reported rather than treated as recovered evidence.

Previously used tools are resolved against the current tool catalog. Their full schemas are preloaded in order of recent use when they fit after the state and recent turns. Remaining tools are listed for discovery when needed. This does not change tool permissions. Small local models use plain JSON to draft the checkpoint, so checkpoint creation does not require native function calling.

Switching to a smaller model applies its budget to the next send. If necessary, Nexus summarizes older context and retains the latest exchanges; the full transcript stays saved. If the prompt still exceeds the budget afterward, the send stops and your draft is restored. Switching back to a larger model does not automatically put compacted messages back into the prompt.

## Web search and costs

Enable **Web search** in chat settings to let supported Anthropic, OpenAI, OpenRouter, or Gemini 3+ models search when needed. Sources appear with the reply. Older direct Gemini models do not expose this option because native chat also uses Nexus tools.

The money counter updates as providers report usage during the reply, including between tool calls. Anthropic cache reads and writes use their separate rates, and Gemini's billed thinking tokens count toward output cost. OpenRouter's reported cost takes precedence when available; other charges are estimates from model pricing. Reported Anthropic and OpenAI search calls are included in the estimate. Google grounding charges and account-specific discounts are not estimated. Very small charges display with extra precision instead of rounding to zero.

---

## Voice And Media Defaults

Open **Settings &rarr; Nexus &rarr; Defaults** to configure the built-in voice and media surfaces:

- **Voice input** sets the transcription provider/model used for chat microphone input and audio ingestion
- **Read aloud** sets the speech provider/model/voice used when Nexus reads a note or selection aloud
- **Live voice** sets the realtime provider/model/voice used by the chat composer voice session
- **Video** sets the default provider/model, aspect ratio, and resolution used by `generateVideo`

The exact options depend on which providers and apps you have enabled.

---

## Live Voice

Use the live voice button in the chat composer to start a realtime voice session inside the current conversation.

- You must already have a conversation selected or created
- User and assistant transcripts are appended back into the chat thread, so the voice exchange becomes part of the conversation history
- The session uses the provider/model/voice selected under **Settings &rarr; Nexus &rarr; Defaults &rarr; Voice &rarr; Live voice**

Live voice comes in two shapes, and the model you pick decides which one you get:

| Shape | Models | How it works |
|-------|--------|--------------|
| **Native agent** | OpenAI GPT Realtime (WebRTC), Gemini 3.8 Live, Gemini 3.8 Live Extended Thinking, Gemini 3.1 Flash Live (WebSocket) | The voice provider owns the whole conversation — it listens, thinks, and speaks |
| **Composed pipeline** | OpenAI GPT Live Transcribe, AssemblyAI Universal 3.5 Pro / 3.6 Pro / 3.6 Realtime | The provider only transcribes. Your reply comes from your normal Nexus chat model and tools, then the configured speech model speaks it |

Composed pipelines are the option to pick when you want live voice to use your actual chat model rather than whatever the voice provider hosts. For those models the voice dropdown reads *"Uses speech default"* and is disabled, since the voice comes from your speech model. Talking over a reply interrupts it — the answer you spoke over is discarded rather than spoken.

If a selected provider is not enabled and configured, Nexus shows an availability error instead of starting the session.

---

## Read Aloud

Nexus can read either the active note or the current selection aloud.

You can start it from:

- The command palette: **Read note aloud**, **Read selection aloud**, **Stop read aloud**
- The editor context menu for selected text
- The file context menu for Markdown notes

When the prompt offers **Save & read**, Nexus plays the audio and also writes a single audio file under your configured storage root and audio subfolder, then inserts a `![[...]]` embed back into the note. Whole-note embeds go at the top of the note body; selection embeds are inserted immediately after the selected text.

Use **Settings &rarr; Nexus &rarr; Defaults &rarr; Voice &rarr; Read aloud** to choose the speech provider/model/voice, and **Saved audio subfolder** to choose where the generated files land.

---

## Generated Media

Native chat also exposes built-in prompt tools for media generation when compatible backends are configured:

- `generateAudio` creates spoken audio files directly in your vault using the configured Voice defaults or an explicit speech provider/model/voice
- `generateVideo` creates MP4 files in your vault using Google or OpenRouter video models
- `checkGeneratedArtifact` resumes a timed-out media job and saves the completed output to the requested vault path

`generateVideo` can return an in-progress result when the provider keeps rendering after the tool timeout. In that case, call `checkGeneratedArtifact` with the returned job ID instead of starting over.

See [Provider setup](provider-setup.md) for which providers unlock these tools.

---

## Conversation Branching

Branch any conversation to explore alternative directions without losing the original thread. Branches are stored as linked conversations with parent metadata.

---

## Providers

Configure providers in **Settings &rarr; Nexus &rarr; Providers**. All configured models appear in the chat model selector.

| Provider | Auth | Notes |
|----------|------|-------|
| Anthropic | API key | `sk-ant-...` |
| OpenAI | API key | `sk-proj-...` |
| Google AI | API key | `AIza...` |
| Mistral | API key | `msak_...` |
| Groq | API key | `gsk_...` |
| OpenRouter | API key or OAuth | `sk-or-...` or sign in |
| Requesty | API key | `req_...` |
| Perplexity | API key | `pplx-...` |
| Ollama | None | Local, requires Ollama running |
| LM Studio | None | Local, requires LM Studio running |
| OpenAI-compatible | Optional API key | Any server with an OpenAI Chat Completions API; add one or more endpoints by URL |
| **Claude Code** | Local CLI | Must be installed and signed in on your computer first; no API key needed |
| **Antigravity CLI** | Local CLI | Install the Antigravity CLI, then run `agy` once to complete Google sign-in; no API key needed. Text-completion only (no tool calling) |
| **GitHub Copilot** | OAuth device flow | Requires active Copilot subscription; sign in via code in modal |
| **Codex (ChatGPT)** | OAuth | Requires ChatGPT Plus/Pro; sign in via browser redirect |

See [Provider setup](provider-setup.md) for connection instructions for API key, local, CLI, and OAuth-backed providers.

---

## Model Selection

Switch between any configured provider and model mid-conversation.

When a new model or a lower **Context window** setting cannot fit the current conversation, Nexus prepares a summary with the previous model before applying the change. It reserves room for the system prompt, tools, and the next response, and keeps recent complete exchanges when they fit. The full transcript stays available in chat history.

In chat settings, the slider previews its value while you drag; **Save** applies the model and budget together. If preparation fails or you cancel it, the previous model and budget remain active. A pending message waits for preparation and stays in the composer if the change fails. Increasing the budget does not restore previously summarized messages to the model's active context.

Each chat saves its committed context budget. Changing Defaults does not alter chats that are already open; new chats use them. The previous provider must be available to generate a handoff summary.

---

## Subagents

The chat can spawn subagent conversations — branched LLM calls that handle tool continuations autonomously, then report results back to the main thread.

Subagents and `executePrompt` runs use the model, thinking, **Creativity** and **Context window** in the **Subagents** section: set them in **Settings &rarr; Nexus &rarr; Defaults**, or for one conversation in chat settings. Without a subagent model, they use the chat model when it is a cloud model, or the first cloud provider with a default model when the chat model is local. The context window also limits how much workspace data and context files a subagent receives; items that do not fit are left out and listed in its prompt.

### Remote Agents

A subagent can also be a **remote agent**: a Hermes or OpenClaw agent running on your own server, with its own tools and environment. Add one in **Settings -> Nexus -> Remote agents** with **Add remote agent**, then pick the **Agent type**, give it a **Name**, enter the **Server URL** (Hermes, including `/v1`) or **Gateway URL** (OpenClaw, `wss://` or `ws://` for localhost), add an **API key** if the server needs one, and click **Test connection**. An optional **Description** helps the model decide when to use it.

Connected, available agents are listed in the chat system prompt, and the model delegates with `prompt sub --target <agent id>`. Leaving out `--target` runs a normal local subagent. You can keep chatting while the remote agent works; its final answer is delivered into the chat that started it. Check on or stop a running job from the agents status menu.

A remote agent does not get access to your vault or Nexus tools. It receives only the task and the context the model includes with it, so that context has to be self-contained. Jobs are saved before they are sent and are recovered after a plugin reload; if you change an agent's address or key while a job is running, the job asks for attention instead of moving to the new server.
