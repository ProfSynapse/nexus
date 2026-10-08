# Provider Setup

Use this guide if you want to chat with Nexus directly inside Obsidian.

Open **Settings -> Nexus -> Providers**, choose a provider, connect it, then select a model in chat.

---

## Choose a Provider Type

| Type | Best for | Examples |
|------|----------|----------|
| API key | Fastest cloud setup | Anthropic, OpenAI, Google AI, Groq, Mistral, OpenRouter, Perplexity, Requesty |
| Local desktop runtime | Local models on your machine | Ollama, LM Studio |
| OpenAI-compatible endpoint | Your own server or gateway that speaks the OpenAI Chat Completions API | Any endpoint you add by URL |
| Existing subscription or local CLI | Reuse an existing login instead of managing API keys | Claude Code, Antigravity CLI, GitHub Copilot, Codex via ChatGPT |

---

## What Provider Setup Unlocks

- **Standard text chat**: any configured chat provider works in the chat model picker
- **Image generation and editing**: configure an OpenAI key to select GPT Image 2.5 Sunburst or Flare. Both use medium quality and accept reference images. Adding these models does not change your saved default.
- **Live voice**: configure OpenAI, Google AI, or AssemblyAI, then choose the live voice provider/model in **Settings &rarr; Nexus &rarr; Defaults &rarr; Voice**. See [Native Chat](native-chat.md) for which models run the whole conversation and which only transcribe
- **Read aloud and `generateAudio`**: configure a speech-capable backend such as OpenAI, ElevenLabs, Google AI, Mistral, or OpenRouter, then choose defaults in **Settings &rarr; Nexus &rarr; Defaults &rarr; Voice**. This is a different surface from live voice and is not OpenAI-only
- **`generateVideo`**: configure Google AI or OpenRouter, then choose defaults in **Settings &rarr; Nexus &rarr; Defaults &rarr; Video**

If you want ElevenLabs voices, sound effects, or music generation, enable the ElevenLabs app in **Settings &rarr; Nexus &rarr; Apps** and see [Apps](apps.md).

---

## API Key Providers

For Anthropic, OpenAI, Google AI, Groq, Mistral, OpenRouter, Perplexity, and Requesty:

1. Open **Settings -> Nexus -> Providers**
2. Select the provider
3. Paste your API key
4. Save or validate the connection if the provider offers validation
5. Open Nexus chat and select one of that provider's models

If you want the simplest setup, an API key provider is usually the fastest path.

### Secure key storage (optional)

By default, API keys live in the plugin's settings file (`data.json`), which syncs with your vault. To keep keys out of synced files, enable **Store API keys in secure storage** in the Providers tab (requires Obsidian 1.11.4+). Keys (including OAuth tokens and app credentials) move into Obsidian's device-local secure storage and are stripped from `data.json` — you will need to re-enter them once on each device. Turning the toggle off writes keys back into `data.json`.

---

## Local Providers

### Ollama

1. Install [Ollama](https://ollama.com/)
2. Make sure Ollama is running and you have at least one model available locally
3. In Nexus, open **Settings -> Providers -> Ollama**
4. Confirm the local endpoint and choose a model in chat

### LM Studio

1. Install [LM Studio](https://lmstudio.ai/)
2. Start the local server in LM Studio
3. In Nexus, open **Settings -> Providers -> LM Studio**
4. Confirm the local endpoint and choose a model in chat

Both local runtimes support **tool calling**, so a capable local model can drive agentic chats (Ollama also auto-discovers every model you have installed). For reasoning models, the model's thinking streams live into collapsible **Thinking** blocks in chat, each placed above the text it led to, and is available in the tool-inspection view.

---

## OpenAI-compatible Endpoints

Use this to connect any local or hosted server that exposes the OpenAI Chat Completions API. You can add several endpoints; each keeps its own address, key and model list.

1. Open **Settings -> Nexus -> Providers** and choose **OpenAI-compatible**
2. Click **Add endpoint**
3. Enter a **Name** (shown in the model picker) and the **API base URL**, including any path such as `/v1`
4. Enter an **API key** only if your server requires one; it is sent as a Bearer token
5. Click **Connect** to discover the server's models through `/models`, then choose which ones to show in the model picker. If the server returns no list, use **Add a model manually** and enter the exact model ID it expects

Chat and standard tool calling work through these endpoints. The endpoint must be reachable from the device you are using, so a `localhost` address only works on that computer.

---

## Claude Code

Use this if you already have [Claude Code](https://claude.ai/download) installed and signed in.

1. Install Claude Code and run `claude` in your terminal to sign in
2. In Nexus, go to **Settings -> Providers -> Anthropic**
3. Click **Connect** under **Claude Code**
4. In chat settings, select a model labeled **(Claude Code)**, such as **Claude Sonnet 5.5 (Claude Code)**

Messages route through your local Claude CLI using your existing subscription. Desktop only.

---

## Antigravity CLI (Google)

Run Google's Gemini models locally through the **Antigravity CLI** (`agy`) using your existing Google account — no API key needed. (This replaces the older Gemini CLI runtime; your existing settings carry over.)

1. Install the Antigravity CLI (`agy`)
2. Run `agy` once in your terminal and complete the Google browser sign-in (there is no `agy auth` command)
3. In Nexus, go to **Settings -> Providers -> Google AI**
4. Wait for the **Antigravity CLI** section to show **Connected**
5. In chat settings, select an Antigravity (Gemini) model and set the thinking level with the effort slider

Messages route through the local Antigravity CLI using your existing Google account. This runtime is **text-completion only — it does not support tool/function calling**, so choose a tool-capable provider for agentic chats. Desktop only.

---

## GitHub Copilot

Use this if you have an active [GitHub Copilot](https://github.com/features/copilot) subscription.

1. In Nexus, go to **Settings -> Providers -> GitHub Copilot**
2. Click **Connect**
3. Copy the device code shown in Nexus, then complete the GitHub auth flow in the browser window that opens
4. After authorization, choose one of the fetched Copilot models in chat

Desktop only. Experimental.

---

## Codex Via ChatGPT

Use this if you have an active ChatGPT Plus or Pro subscription and want supported OpenAI models through your ChatGPT login. Model access depends on your account and the subscription endpoint.

1. In Nexus, go to **Settings -> Providers -> OpenAI**
2. Click **Connect** under **ChatGPT (Codex)**
3. Sign in with your ChatGPT account in the browser window that opens
4. In chat settings, select a model labeled **(ChatGPT)**

Desktop only. Experimental.

If ChatGPT rejects a saved refresh token during a Codex request, Nexus shows a notice and changes the provider card to **Reconnect with ChatGPT**. Open the OpenAI provider settings and reconnect to continue. Opening Settings alone does not check the connection.

---

## OpenRouter OAuth

If you prefer OpenRouter browser sign-in instead of an API key:

1. In Nexus, go to **Settings -> Providers -> OpenRouter**
2. Choose the connect or sign-in option
3. Complete the browser auth flow
4. Select an OpenRouter model in chat

If you already have an OpenRouter API key, that is usually the simpler route.

---

## Remote Agents Are Not Providers

**Settings -> Nexus -> Remote agents** connects a separate agent (Hermes or OpenClaw) that runs its own tools and that Nexus can hand tasks to. It does not add models to the model picker. See [Native chat](native-chat.md#remote-agents).

---

## Next Guides

- [Native chat](native-chat.md)
- [Recommended system prompt](recommended-system-prompt.md)
- [MCP setup](mcp-setup.md)
