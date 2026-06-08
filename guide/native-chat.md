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

In the current build, live voice is wired only for **OpenAI realtime/WebRTC**. If another provider is selected in the defaults UI, Nexus will show an availability error instead of starting the session.

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
| **Claude Code** | Local CLI | Must be installed and signed in on your computer first; no API key needed |
| **Gemini CLI** | Local CLI | Must be installed and signed in on your computer first; no API key needed |
| **GitHub Copilot** | OAuth device flow | Requires active Copilot subscription; sign in via code in modal |
| **Codex (ChatGPT)** | OAuth | Requires ChatGPT Plus/Pro; sign in via browser redirect |

See [Provider setup](provider-setup.md) for connection instructions for API key, local, CLI, and OAuth-backed providers.

---

## Model Selection

Switch between any configured provider and model mid-conversation.

---

## Subagents

The chat can spawn subagent conversations — branched LLM calls that handle tool continuations autonomously, then report results back to the main thread.
