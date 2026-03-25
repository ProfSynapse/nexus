# Provider Setup

Use this guide if you want to chat with Nexus directly inside Obsidian.

Open **Settings -> Nexus -> Providers**, choose a provider, connect it, then select a model in chat.

---

## Choose a Provider Type

| Type | Best for | Examples |
|------|----------|----------|
| API key | Fastest cloud setup | Anthropic, OpenAI, Google AI, Groq, Mistral, OpenRouter, Perplexity, Requesty |
| Local desktop runtime | Local models on your machine | Ollama, LM Studio |
| Existing subscription or local CLI | Reuse an existing login instead of managing API keys | Claude Code, Gemini CLI, GitHub Copilot, Codex via ChatGPT |

---

## API Key Providers

For Anthropic, OpenAI, Google AI, Groq, Mistral, OpenRouter, Perplexity, and Requesty:

1. Open **Settings -> Nexus -> Providers**
2. Select the provider
3. Paste your API key
4. Save or validate the connection if the provider offers validation
5. Open Nexus chat and select one of that provider's models

If you want the simplest setup, an API key provider is usually the fastest path.

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

---

## Claude Code

Use this if you already have [Claude Code](https://claude.ai/download) installed and signed in.

1. Install Claude Code and run `claude` in your terminal to sign in
2. In Nexus, go to **Settings -> Providers -> Anthropic**
3. Click **Connect** under **Claude Code**
4. In chat settings, select a model labeled **(Claude Code)**, such as **Claude Sonnet 4.6 (Claude Code)**

Messages route through your local Claude CLI using your existing subscription. Desktop only.

---

## Gemini CLI

Use this if you already have [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and signed in.

1. Install Gemini CLI: `npm install -g @google/gemini-cli`
2. Run `gemini` in your terminal and complete the Google sign-in flow
3. In Nexus, go to **Settings -> Providers -> Google AI**
4. Wait for the **Gemini CLI** section to show **Connected**
5. In chat settings, select a Gemini CLI model

Messages route through the local Gemini CLI using your existing Google account. Desktop only.

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

Use this if you have an active ChatGPT Plus or Pro subscription and want GPT-5 models through your ChatGPT login.

1. In Nexus, go to **Settings -> Providers -> OpenAI**
2. Click **Connect** under **ChatGPT (Codex)**
3. Sign in with your ChatGPT account in the browser window that opens
4. In chat settings, select a model labeled **(ChatGPT)**

Desktop only. Experimental.

---

## OpenRouter OAuth

If you prefer OpenRouter browser sign-in instead of an API key:

1. In Nexus, go to **Settings -> Providers -> OpenRouter**
2. Choose the connect or sign-in option
3. Complete the browser auth flow
4. Select an OpenRouter model in chat

If you already have an OpenRouter API key, that is usually the simpler route.

---

## Next Guides

- [Native chat](native-chat.md)
- [Recommended system prompt](recommended-system-prompt.md)
- [MCP setup](mcp-setup.md)
