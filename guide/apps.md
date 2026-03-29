# Apps

Apps are downloadable tool domains that extend Nexus with third-party integrations. Each app brings its own tools, credentials, and API connections — install only what you need.

---

## Setup

Configure apps in **Settings &rarr; Nexus &rarr; Apps**. Enter your API key, hit **Validate**, and the modal will confirm which capabilities your key supports (and flag any missing permissions).

---

## Available Apps

| App | Tools | What It Does |
|-----|-------|--------------|
| **ElevenLabs** | textToSpeech, listVoices, soundEffects, generateMusic | AI audio generation — convert text to speech, create sound effects, and generate music. Audio files save directly to your vault. |

---

## Requesting & Contributing Apps

Have an idea for a new app? [Open an issue](https://github.com/ProfSynapse/claudesidian-mcp/issues) with the `app-request` label.

Want to build your own? See **[Building Apps](../docs/BUILDING_APPS.md)** — an agentic prompt you can feed to your AI coding assistant to create a new app from scratch. It covers the full pattern: manifest, agent class, tools, vault file saving, and registration.
