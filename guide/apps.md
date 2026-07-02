# Apps

Apps are optional tool domains that extend Nexus with third-party integrations and desktop workflows. Each app brings its own tools, credentials, and API connections; enable only what you need.

---

## Setup

Configure apps in **Settings -> Nexus -> Apps**. Install an app, enter your API key when required, hit **Validate**, then toggle it on. Built-in apps do not download extra npm packages when enabled.

---

## Available Apps

> **Experimental**: Composer, Web Tools, Nexus Ingester, and Data Analysis are new and may have rough edges. Please [report issues](https://github.com/ProfSynapse/claudesidian-mcp/issues) if you run into problems.

| App | Tools | What It Does |
|-----|-------|--------------|
| **Skills** | listSkills, loadSkill, createSkill, updateSkill, archiveSkill, syncSkills | Author, index, and load reusable agent **Skills** (per the Skills Protocol) straight from your vault. Discover available skills, load one with its bundled files into context, and create/update/archive them over time. A background watcher keeps the index in sync as you edit skill files. Skills are **vault-local** — Nexus never reaches into OS-home provider folders. Works on desktop and mobile. |
| **Data Analysis** *(experimental, desktop only)* | runPython, listCapabilities | Run Python (pandas) against your vault's CSV and Excel data in a sandboxed Pyodide worker. Workbooks project into editable CSVs and **write back automatically** — formulas, charts, images, and pivots are preserved byte-for-byte. No setup beyond enabling the app; the Python engine loads on first use. Requires desktop; not available on mobile. |
| **ElevenLabs** | textToSpeech, listVoices, soundEffects, generateMusic | AI audio generation: convert text to speech, create sound effects, and generate music. Audio files save directly to your vault. When enabled, ElevenLabs voices also become available to the built-in read-aloud and `generateAudio` flows through the Voice defaults. |
| **Nexus Ingester** *(experimental)* | ingest, listCapabilities | Convert PDF, DOCX, PPTX, and audio files in your vault to sibling Markdown notes. Two modes: **Manual** - right-click any supported file and choose "Convert to Markdown". **Auto** - enable "Auto-convert new files" in Settings -> Defaults -> Ingestion and any supported file added to the vault is converted automatically. PDF extraction uses text mode or OCR. OCR supports **Mistral OCR** (native, or via OpenRouter) — which returns full-fidelity text and extracts embedded images into a per-note folder, linked inline — as well as vision-model OCR. The PDF worker is loaded only when PDF ingestion runs. Audio transcription supports OpenAI (Whisper, GPT-4o Transcribe), Groq (Whisper), and Google Gemini multimodal audio. XLSX ingestion is not included in the core release. |
| **Composer** *(experimental)* | compose, listFormats | Combine multiple files into one. Merge PDFs, concatenate Markdown files, or mix and concat audio tracks. Audio input supports common browser-decodable formats such as MP3 and WAV. Audio output supports WAV and WebM/Opus. Supports per-track volume, offset, and fade controls for audio mixing. |
| **Web Tools** *(experimental, desktop only)* | openWebpage, capturePagePdf, capturePagePng, captureToMarkdown, extractLinks | Open any webpage in a headless browser and capture it as a PDF, PNG, or clean Markdown (boilerplate stripped). Also extracts all links with their text and type. Requires desktop; not available on mobile. |

---

## Requesting & Contributing Apps

Have an idea for a new app? [Open an issue](https://github.com/ProfSynapse/claudesidian-mcp/issues) with the `app-request` label.

Want to build your own? See **[Building Apps](../docs/BUILDING_APPS.md)**, an agentic prompt you can feed to your AI coding assistant to create a new app from scratch. It covers the full pattern: manifest, agent class, tools, vault file saving, and registration.
