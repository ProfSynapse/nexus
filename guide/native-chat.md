# Native Chat

Nexus includes a full chat interface inside Obsidian — no need to switch to an external app.

---

## Getting Started

1. Configure a provider in **Settings &rarr; Nexus &rarr; Providers**
2. Open chat via the ribbon icon or command palette (**Nexus: Open Nexus Chat**)
3. Start typing — responses stream in real time

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
