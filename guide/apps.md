# Apps

Apps are downloadable tool domains that extend Nexus with third-party integrations. Each app brings its own tools, credentials, and API connections — install only what you need.

---

## Setup

Configure apps in **Settings &rarr; Nexus &rarr; Apps**. Enter your API key, hit **Validate**, and the modal will confirm which capabilities your key supports (and flag any missing permissions).

---

## Available Apps

> ⚠️ **Experimental**: Composer, Web Tools, and Nexus Ingester are new and may have rough edges. Please [report issues](https://github.com/ProfSynapse/claudesidian-mcp/issues) if you run into problems.

| App | Tools | What It Does |
|-----|-------|--------------|
| **ElevenLabs** | textToSpeech, listVoices, soundEffects, generateMusic | AI audio generation — convert text to speech, create sound effects, and generate music. Audio files save directly to your vault. |
| **Nexus Ingester** *(experimental)* | ingest, listCapabilities | Drag a PDF or audio file onto the chat window to convert it into a Markdown note. PDF extraction uses text mode (pdfjs-dist) or vision OCR. Audio transcription uses Whisper via OpenAI or Groq. The resulting note is saved alongside the original file in your vault. |
| **Composer** *(experimental)* | compose, listFormats | Combine multiple files into one. Merge PDFs, concatenate Markdown files, or mix and concat audio tracks. Audio output supports WAV, WebM/Opus, and MP3 (via WASM). Supports per-track volume, offset, and fade controls for audio mixing. |
| **Web Tools** *(experimental, desktop only)* | openWebpage, capturePagePdf, capturePagePng, captureToMarkdown, extractLinks | Open any webpage in a headless browser and capture it as a PDF, PNG, or clean Markdown (boilerplate stripped). Also extracts all links with their text and type. Requires desktop — not available on mobile. |

---

## Requesting & Contributing Apps

Have an idea for a new app? [Open an issue](https://github.com/ProfSynapse/claudesidian-mcp/issues) with the `app-request` label.

Want to build your own? See **[Building Apps](../docs/BUILDING_APPS.md)** — an agentic prompt you can feed to your AI coding assistant to create a new app from scratch. It covers the full pattern: manifest, agent class, tools, vault file saving, and registration.
