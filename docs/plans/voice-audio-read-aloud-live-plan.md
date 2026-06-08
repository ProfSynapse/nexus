# Implementation Plan: Voice Defaults, Read Aloud, and Live Voice

> Created on 2026-06-07
> Status: SCOPED

## Summary

Add a first-class **Voice** settings section for Nexus and use it to support two related but separate product surfaces:

- **Read aloud**: read Markdown notes or selected text using normal speech/TTS models.
- **Live voice**: turn chat into a true realtime voice session only for providers/apps that support realtime audio conversations.

This plan intentionally does **not** use a chained live-voice fallback such as microphone capture -> transcription -> normal text chat -> TTS. That path is useful for some products, but it creates different latency, interruption, tool-call, transcript, and state semantics than a true realtime voice session. Nexus should expose it as voice input/transcription, not call it live voice.

This plan is scope only. No production code changes are included here.

## Product Decisions

- Read aloud and live voice are separate capabilities.
- Read aloud may use normal TTS/speech-generation models.
- Live voice only unlocks for true realtime voice providers or apps.
- Existing transcription settings should move under a broader **Voice** section.
- PDF/OCR/file conversion defaults should remain under **Ingestion**.
- Provider/app setup still belongs in **Providers** and **Apps**. The Voice section only selects defaults from configured capabilities.
- App-backed voice capabilities should unlock when the app is installed, enabled, and configured.
- Live voice should use a **composer takeover**, not a full-screen replacement. The normal message stream stays visible and receives transcript/assistant text.
- The live composer itself should stay visual: recording dot, stateful waveform/indicator, and stop button. State copy belongs in the existing chat status bar.
- Connecting and error states must not show speech waveform bars. Connecting should use a non-speech loading indicator; error should use a non-speech error mark plus actionable status text.

## Existing Repo Context

Relevant existing surfaces:

- `src/services/llm/types/VoiceTypes.ts` already defines transcription model declarations and default resolution.
- `src/services/llm/TranscriptionService.ts` already provides provider-backed transcription for audio ingestion and chat voice input.
- `src/ui/chat/controllers/ChatVoiceInputController.ts` already implements chunked microphone capture into transcription.
- `src/settings/tabs/DefaultsTab.ts` currently renders ingestion and transcription defaults.
- `src/services/apps/AppManager.ts` manages app install/enable/configuration state.
- `src/agents/apps/BaseAppAgent.ts` already supports app-specific settings and a `fetchTTSModels()` extension point.
- `src/settings/tabs/AppsTab.ts` already exposes ElevenLabs `defaultTTSModel` settings when the ElevenLabs app is configured.
- `src/agents/apps/elevenlabs/tools/textToSpeech.ts` already shows the request and vault-binary-save pattern for ElevenLabs TTS.
- `src/core/commands/InlineEditCommandManager.ts` is the reference for editor command and editor context-menu registration.
- `src/core/ingest/VaultIngestionManager.ts` is the reference for file-menu registration.

## Target Settings Shape

### Ingestion

Keep file conversion defaults here:

- PDF mode
- OCR provider/model
- Auto-ingestion controls

Do not keep read-aloud or live voice controls here.

### Voice

New top-level defaults area, probably still inside the Defaults tab at first:

#### Voice Input

- Transcription provider
- Transcription model
- Used by chat microphone input and audio-file transcription

#### Read Aloud

- Speech provider
- Speech model
- Voice
- Speed
- Style/instructions
- YAML frontmatter is always skipped for note read-aloud.

Read aloud should be enabled when at least one configured speech provider is available.

#### Live Voice

- Realtime provider/app
- Realtime model
- Voice

Live voice should be locked unless at least one configured realtime voice provider/app is available.

## Live Voice Composer Design

Reviewed mockup:

- `docs/mockups/live-voice-composer.html`
- `docs/mockups/live-voice-composer.css`
- `docs/mockups/live-voice-composer.js`

Production alignment:

- `src/ui/chat/components/ChatInput.ts` owns the composer mode because it already switches between normal input, transcription recording, transcribing, send, and stop states.
- `src/ui/chat/components/ToolStatusBar.ts` owns live voice status text because this matches existing Nexus status conventions and keeps state copy out of the composer.
- `src/ui/chat/builders/ChatLayoutBuilder.ts` owns the header entry button because live voice is a chat mode, not a one-shot composer action.
- `src/ui/chat/ChatView.ts` wires the entry button to the live voice controller/shell and ensures cleanup on unload.

Visual states:

| State | Composer visual | Status bar text |
| --- | --- | --- |
| Inactive | Normal text composer | none |
| Connecting | Dot + spinner/scan indicator + stop | `Connecting live voice...` |
| Listening | Dot + low waveform + stop | `Listening` |
| User speaking | Dot + tighter/jagged waveform + stop | `Transcribing your speech...` |
| Assistant speaking | Dot + fuller/smoother waveform + stop | `Nexus is speaking...` |
| Error | Dot + error mark + stop | `Live voice connection failed. Stop and try again.` |

Accessibility:

- Composer visuals remain `aria-hidden`.
- The live composer wrapper gets a stable `aria-label`.
- The stop control uses `aria-label="Stop live voice"`.
- Status text uses the existing status-bar live region.

Phase boundary:

- This UI shell does not fake provider audio. Until realtime provider adapters are wired, the header entry should show a clear status/error rather than pretending a live session is working.
- Provider runtime work should connect real OpenAI/Google/ElevenLabs events into the same state API rather than rewriting the composer.

## Default Resolution Policy

Voice defaults must be deterministic and must not silently drift when the user enables more providers.

### States

Each voice capability default should track both the selected value and how it was selected:

```ts
type DefaultSelectionSource = 'auto' | 'user';

interface VoiceDefaultSelection {
  provider?: string;
  model?: string;
  voice?: string;
  source: DefaultSelectionSource;
  lastAutoProvider?: string;
  lastAutoModel?: string;
}
```

Use this state separately for:

- transcription
- read-aloud speech
- live voice

### Auto Selection

When no user selection exists:

1. Build the list of configured providers/apps that support the capability.
2. Sort by a stable product-defined priority.
3. Pick the first enabled provider's recommended default model.
4. Mark the setting as `source: 'auto'`.
5. Show the UI label as `Auto: Google Gemini TTS` or similar.

Recommended priority:

- Read aloud: ElevenLabs, OpenAI, Google, OpenRouter
- Live voice: OpenAI, Google, ElevenLabs
- Voice input/transcription: current transcription default resolution order unless changed deliberately

The priority should live in one resolver file, not inside UI rendering code.

### User Selection

As soon as the user explicitly picks a provider/model/voice, mark that default as `source: 'user'`.

After that:

- enabling another provider must not change the selected default
- installing another app must not change the selected default
- model list refreshes must not change the selected default if the selected model still exists

### When A User Default Becomes Invalid

If the selected provider/app is disabled, uninstalled, missing credentials, or the selected model disappears:

1. Keep the stored user selection.
2. Mark the UI state as invalid.
3. Show a clear status such as `Selected model unavailable. Choose another model or re-enable OpenAI.`
4. Do not auto-switch unless the user chooses `Use automatic default`.

This prevents surprising behavior where enabling Google first and OpenAI later changes the voice unexpectedly.

### Reset To Auto

Each capability section should include a `Use automatic default` option.

Choosing it:

- clears the explicit provider/model/voice selection
- sets `source: 'auto'`
- immediately resolves against currently configured providers/apps

### Runtime Fallback

Runtime should follow the same rules:

1. Use valid user default if available.
2. Use auto-resolved default if source is `auto`.
3. If source is `user` but invalid, fail with an actionable message instead of falling back silently.

Example messages:

- `Read aloud is set to OpenAI, but OpenAI speech is not configured. Update Voice settings.`
- `Live voice is set to Gemini Live, but Google is disabled. Re-enable Google or choose another realtime provider.`

## Provider Capability Buckets

### Transcription

Existing bucket. Supports speech-to-text, not speech output.

Current examples:

- OpenAI transcription
- Groq Whisper
- Mistral Voxtral
- Deepgram
- AssemblyAI

### Speech / TTS

New bucket. Supports text-to-speech for read aloud.

Initial candidates:

- OpenAI speech endpoint
- Google Gemini TTS
- ElevenLabs TTS app
- OpenRouter speech endpoint

### Realtime Voice

New bucket. Supports true realtime audio conversation.

Initial candidates:

- OpenAI Realtime
- Google Gemini Live
- ElevenLabs Conversational AI or realtime agent path

Do not include transcription-only providers here.

## Current Realtime Provider Docs Snapshot

> Verified against official provider docs on 2026-06-07. Re-check these docs immediately before implementing PR 7/PR 8 because realtime voice APIs are changing quickly.

### OpenAI Realtime

Official docs:

- Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- WebRTC guide: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Realtime conversations: https://developers.openai.com/api/docs/guides/realtime-conversations
- Client secrets reference: https://platform.openai.com/docs/api-reference/realtime-sessions
- Calls reference: https://platform.openai.com/docs/api-reference/realtime/create-call

Current API shape:

- Browser/mobile client path should prefer WebRTC.
- Server path can use WebSockets.
- Browser session setup has two documented options:
  - unified interface: browser posts SDP to a trusted server, server posts multipart form data to `POST https://api.openai.com/v1/realtime/calls`
  - ephemeral token: server creates a client secret with `POST https://api.openai.com/v1/realtime/client_secrets`, browser posts SDP directly to `POST https://api.openai.com/v1/realtime/calls` using the ephemeral key
- Session config uses the GA-style shape:

```json
{
  "type": "realtime",
  "model": "gpt-realtime-2",
  "audio": {
    "output": {
      "voice": "marin"
    }
  }
}
```

- WebRTC media flow:
  - browser creates `RTCPeerConnection`
  - browser attaches local microphone track from `getUserMedia({ audio: true })`
  - browser receives model audio through `pc.ontrack`
  - browser creates a data channel such as `oai-events` for JSON events
- Realtime conversation state includes session, conversation, and response items.
- Session can be updated with `session.update` events.
- OpenAI currently documents `gpt-realtime-2` as the realtime model in examples.
- Current voice options listed in docs include `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`; docs recommend `marin` or `cedar` for quality.
- Once the model has emitted audio in a session, the session voice cannot be changed.
- Realtime session maximum duration is documented as 60 minutes.

Implementation notes for Nexus:

- Since Obsidian is Electron/browser-like, WebRTC is the likely first path.
- Do not expose standard OpenAI API keys to browser-side code. If using the direct browser call path, create ephemeral client secrets through a trusted plugin/server-side path.
- Validate whether Obsidian mobile can use the WebRTC path and whether CORS/app-origin restrictions require a Node-side helper on desktop.
- Existing OpenAI CORS bypass work for Responses does not automatically solve WebRTC/realtime setup.

### Google Gemini Live

Official docs:

- Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Live API capabilities: https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Live WebSocket API reference: https://ai.google.dev/api/live
- Live session management: https://ai.google.dev/gemini-api/docs/live-session
- Ephemeral tokens: linked from the Live API docs at https://ai.google.dev/gemini-api/docs/live-api

Current API shape:

- Live API supports low-latency real-time voice and vision interactions.
- It supports server-to-server WebSockets and client-to-server WebSockets.
- For production client-to-server, Google recommends ephemeral tokens instead of standard API keys.
- Raw WebSocket endpoint:

```text
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
```

- Initial WebSocket message sets session configuration, including model, generation parameters, system instructions, and tools.
- SDK shape in JavaScript:

```ts
const session = await ai.live.connect({
  model: "gemini-3.1-flash-live-preview",
  callbacks: {
    onopen: () => {},
    onmessage: (message) => {},
    onerror: (event) => {},
    onclose: (event) => {},
  },
  config: {
    responseModalities: [Modality.AUDIO],
  },
});
```

- Audio input via SDK uses `sendRealtimeInput`, with audio payloads such as:

```ts
session.sendRealtimeInput({
  audio: {
    data: base64Audio,
    mimeType: "audio/pcm;rate=16000"
  }
});
```

- Optional transcription config:
  - output audio transcription: `outputAudioTranscription: {}`
  - input audio transcription: `inputAudioTranscription: {}`
- Session resumption exists through `sessionResumption` config and server resumption updates.
- Google documents session lifetime and connection lifetime constraints; session resumption and context window compression are part of the strategy for longer sessions.
- Examples currently show `gemini-3.1-flash-live-preview`; session-management examples also reference native-audio preview models.

Implementation notes for Nexus:

- Gemini Live is WebSocket-oriented rather than browser WebRTC-native in the core docs, though partner integrations can provide WebRTC.
- Browser microphone audio likely needs conversion to the expected PCM format if using raw WebSocket/SDK payloads.
- Need to decide whether to use the Google GenAI SDK in Electron or raw WebSocket messages for tighter control.
- Tool-use support should be spiked before committing to a provider abstraction, because Gemini Live tool-call events may not map exactly to existing Nexus tool call flow.

### ElevenLabs Conversational AI / ElevenAgents

Official docs:

- WebSocket guide: https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets
- Signed URL API: https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url
- Agent authentication: https://elevenlabs.io/docs/conversational-ai/customization/authentication

Current API shape:

- Realtime conversation endpoint:

```text
wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}
```

- Public agents can connect with `agent_id`.
- Private/authenticated agents should use signed URLs.
- Signed URL request:

```http
GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id={agent_id}
xi-api-key: <api-key>
```

- Signed URL response:

```json
{
  "signed_url": "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...&token=..."
}
```

- Signed URLs are intended to avoid exposing the ElevenLabs API key to client-side code.
- WebSocket supports client/server events for a conversational agent, including contextual update events.
- ElevenLabs also has a separate TTS WebSocket endpoint for streaming text-to-speech:

```text
wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
```

That endpoint is useful for read aloud, but it is not the same as live voice chat.

Implementation notes for Nexus:

- ElevenLabs live voice is agent-centric. Nexus must decide whether users select an existing ElevenLabs agent, create/manage one from Nexus, or treat this as an app setup prerequisite.
- Existing ElevenLabs app credentials are a natural unlock gate.
- The live adapter should not be conflated with the existing `textToSpeech` tool or TTS WebSocket path.
- Tool integration may require ElevenLabs client tools or MCP support, not the same direct function-call loop used by normal Nexus chat.

## Settings Schema

Extend `LLMProviderSettings` or introduce a nested voice settings object. Prefer a nested object if the migration stays small, because the feature now has multiple voice-related defaults.

Recommended shape:

```ts
interface VoiceSettings {
  defaultTranscriptionModel?: DefaultModelSettings;
  defaultSpeechModel?: {
    provider: string;
    model: string;
    voice?: string;
  };
  defaultRealtimeVoiceModel?: {
    provider: string;
    model: string;
    voice?: string;
  };
}
```

Migration options:

- Low-churn v1: keep `defaultTranscriptionModel` where it is and add `defaultSpeechModel` / `defaultRealtimeVoiceModel` beside it.
- Cleaner v2: move the three settings under `voice`, with backward-compatible loading from the old `defaultTranscriptionModel`.

Recommendation: use the low-churn v1 shape first, then consolidate once the UI and services stabilize.

## Architecture

### Capability Catalogs

Add dedicated catalog files instead of expanding text-chat `ModelSpec`.

Recommended files:

- `src/services/llm/types/SpeechTypes.ts`
- `src/services/llm/types/RealtimeVoiceTypes.ts`

Keep `VoiceTypes.ts` for transcription for now, or later rename it to `TranscriptionTypes.ts` if the churn is justified.

Speech catalog responsibilities:

- declare provider/model IDs
- declare voices, or declare whether voices are fetched dynamically
- declare request limits, streaming support, response formats, and default voice
- resolve configured defaults

Realtime catalog responsibilities:

- declare provider/app IDs
- declare realtime model IDs
- declare voice options, turn detection defaults, and transport type
- resolve configured defaults only from enabled/configured providers/apps

### Services

New services:

- `SpeechSynthesisService`
- `ReadAloudService`
- later: `RealtimeVoiceSessionService`

`SpeechSynthesisService` owns provider adapters and text-to-audio generation.

`ReadAloudService` owns note/selection extraction, frontmatter stripping, Markdown speech cleanup, chunk planning, and playback orchestration.

`RealtimeVoiceSessionService` owns native realtime sessions only. It should not call `TranscriptionService` as a fallback.

### Provider Adapters

Use small adapters behind shared interfaces:

```ts
interface SpeechAdapter {
  provider: SpeechProvider;
  isAvailable(): boolean;
  getModels(): SpeechModelDeclaration[];
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
}

interface RealtimeVoiceAdapter {
  provider: RealtimeVoiceProvider;
  isAvailable(): boolean;
  getModels(): RealtimeVoiceModelDeclaration[];
  startSession(request: RealtimeVoiceSessionRequest): Promise<RealtimeVoiceSession>;
}
```

Read-aloud adapters:

- `OpenAISpeechAdapter`
- `GoogleSpeechAdapter`
- `ElevenLabsSpeechAdapter`
- `OpenRouterSpeechAdapter`

Realtime adapters:

- `OpenAIRealtimeVoiceAdapter`
- `GoogleLiveVoiceAdapter`
- `ElevenLabsRealtimeVoiceAdapter`

## SOLID / DRY Rules

### Single Responsibility

- `TranscriptionService` stays speech-to-text only.
- `SpeechSynthesisService` handles text-to-audio provider calls only.
- `ReadAloudService` handles note extraction, cleanup, chunking, and playback only.
- `RealtimeVoiceSessionService` handles realtime audio session lifecycle only.
- Settings renderers render controls only; they should not know provider HTTP details.

### Open / Closed

Adding a new speech provider should mean:

- add a catalog declaration
- add an adapter
- register the adapter

It should not require editing the read-aloud command, playback UI, or settings normalization logic.

Adding a new realtime provider should follow the same pattern through the realtime catalog and adapter registry.

### Liskov Substitution

Every speech adapter must satisfy the same behavior contract:

- report availability without throwing
- return stable model declarations
- return audio bytes or a stream in a normalized result
- surface provider errors as typed failures

The read-aloud service should not special-case provider classes except for capability flags declared in the catalog.

### Interface Segregation

Do not create a single large `VoiceProviderAdapter` with transcription, TTS, and realtime methods. Providers often support only one or two of those capabilities.

Use separate interfaces:

- `TranscriptionAdapter`
- `SpeechAdapter`
- `RealtimeVoiceAdapter`

### Dependency Inversion

UI commands and settings should depend on services and capability resolvers, not concrete provider implementations.

`ReadAloudCommandManager` should call `ReadAloudService`.

`ReadAloudService` should call `SpeechSynthesisService`.

`SpeechSynthesisService` should call `SpeechAdapter` instances through an adapter registry.

### DRY Boundaries

Share:

- provider/model default resolution helpers
- enabled/configured provider gating helpers
- app-enabled/configured gating helpers
- voice option normalization
- audio byte playback helpers
- frontmatter stripping and Markdown speech cleanup

Do not share:

- transcription chunking with TTS chunking; the constraints differ
- realtime session logic with read-aloud playback; one is conversational, one is document narration
- tool implementations with UI services; existing ElevenLabs TTS tool can inspire request code, but UI playback should use a shared speech adapter

## Read-Aloud UX Contract

### Entry Points

- Command palette: `Read current note aloud`
- Editor context menu:
  - `Read selection aloud` when text is selected
  - `Read note aloud` otherwise, if a Markdown file is active
- File menu:
  - `Read aloud` for Markdown files

### Text Preparation

V1 preparation:

- read active selection if present
- otherwise read the target Markdown file
- strip YAML frontmatter by default
- remove code fence bodies or replace them with a short spoken placeholder
- simplify Markdown links to visible link text
- simplify embeds and images to alt text or skip
- collapse tables into readable rows only if simple; otherwise skip with a short placeholder

Avoid mutating the source note.

### Playback

V1 should support:

- start
- stop
- visible status notice or compact floating control
- sequential chunk playback for long notes

Pause/resume and seek can be follow-ups unless provider streaming makes them cheap.

## Live Voice UX Contract

### Gating

Live voice controls are hidden or disabled unless a realtime voice provider/app is:

- installed where applicable
- enabled
- configured with required credentials
- capable of at least one realtime model

### Chat Behavior

V1 settings can ship before live session implementation. When implemented:

- live mode opens an actual realtime provider session
- the session receives microphone audio directly
- the model returns audio directly
- transcript events, if available, are persisted into the normal conversation history
- tool calls must remain compatible with Nexus tool-call display and trace storage

No chained fallback.

## UI Mockup Requirement

Before production UI changes, create a standalone mockup:

- `docs/mockups/voice-audio-settings.html`
- optional companion CSS/JS if interaction grows

The mockup should show:

- configured and unconfigured states
- locked read-aloud settings
- unlocked read-aloud settings
- locked live voice settings
- app-backed realtime unlock behavior
- mobile-width layout

## Proposed Production File Touch Points

New files:

- `src/services/llm/types/SpeechTypes.ts`
- `src/services/llm/types/RealtimeVoiceTypes.ts`
- `src/services/llm/SpeechSynthesisService.ts`
- `src/services/readAloud/ReadAloudService.ts`
- `src/services/readAloud/MarkdownSpeechPreprocessor.ts`
- `src/services/readAloud/ReadAloudPlaybackController.ts`
- `src/core/commands/ReadAloudCommandManager.ts`

Likely modified files:

- `src/types/llm/ProviderTypes.ts`
- `src/settings/tabs/DefaultsTab.ts`
- `src/components/shared/IngestModelDropdownRenderer.ts`, if it needs to be split or generalized
- `src/services/StaticModelsService.ts`
- `src/services/apps/AppManager.ts`, if app capability metadata is exposed centrally
- `src/agents/apps/BaseAppAgent.ts`, if app speech/realtime capability methods need to be generalized beyond ElevenLabs TTS
- `src/agents/apps/elevenlabs/ElevenLabsAgent.ts`
- `src/core/PluginLifecycleManager.ts`
- `styles.css`

Possible tests:

- `tests/unit/MarkdownSpeechPreprocessor.test.ts`
- `tests/unit/SpeechTypes.test.ts`
- `tests/unit/RealtimeVoiceTypes.test.ts`
- `tests/unit/ReadAloudService.test.ts`
- `tests/unit/VoiceAudioSettings.test.ts`

## Implementation Phases

### Phase 1: Capability And Settings Groundwork

- Add speech and realtime capability types/catalogs.
- Add default speech and realtime settings.
- Add normalization helpers that preserve existing `defaultTranscriptionModel`.
- Add provider/app gating helpers.
- Add tests for default resolution and locked/unlocked states.

### Phase 2: Voice Settings UI Mockup

- Create `docs/mockups/voice-audio-settings.html`.
- Model one Defaults tab `Voice` section with ordinary settings rows.
- Include Voice input, Read aloud, and Live voice controls inside that section.
- Use labels that match the setting being chosen: Transcription provider, Speech provider, Live voice provider.
- Include disabled states and configured examples without exposing internal capability/resolution panels.
- Review before production settings changes.

### Phase 3: Production Settings UI

- Keep Ingestion focused on PDF/OCR/file conversion.
- Add a single Voice section.
- Move transcription dropdowns under Voice.
- Add read-aloud speech model/voice controls.
- Add live voice controls, locked behind realtime capability availability.
- Do not add speed/style controls in the first production pass.

### Phase 4: Read-Aloud V1

- Add Markdown speech preprocessor.
- Add `SpeechSynthesisService` and one adapter first.
- Add `ReadAloudService`.
- Add command, editor-menu, and file-menu entry points.
- Add basic playback status and stop behavior.

Recommended first adapter: ElevenLabs if app-backed unlock is the priority, or OpenAI if provider-backed setup is simpler in current provider settings.

### Phase 5: Unified Audio Tool Design

- Decide whether Nexus should add a `generateAudio` tool that absorbs the current ElevenLabs audio tools.
- Proposed mode shape: `voice`, `music`, and `sfx`.
- Keep read-aloud tied to `voice`/TTS only; do not let music or SFX leak into note playback.
- Gate modes by provider/app capabilities:
  - `voice`: ElevenLabs, OpenAI, Google, OpenRouter, depending on configured speech support.
  - `music`: ElevenLabs only until another configured provider supports music generation.
  - `sfx`: ElevenLabs only until another configured provider supports sound effects.
- Decide whether existing ElevenLabs `textToSpeech`, `musicGeneration`, and `soundEffects` tools are deprecated, wrapped, or left as app-specific advanced tools.
- Decide whether generated audio always requires an `outputPath`, or whether read-aloud remains playback-only and `generateAudio` is artifact-first.

### Phase 6: Additional Speech Providers

- Add remaining speech adapters.
- Add dynamic voice/model loading where provider APIs support it.
- Add provider-specific request-limit chunking.

### Phase 7: Live Voice Settings And Spike

- Keep UI gated but non-functional until at least one native realtime adapter is implemented.
- Spike OpenAI Realtime or Gemini Live first.
- Validate how tool calls, transcripts, interruptions, and conversation persistence map into Nexus.

### Phase 8: Live Voice Implementation

- Implement one realtime adapter.
- Add chat live-mode controller.
- Add transcript/tool-call persistence integration.
- Add stop/interruption cleanup.
- Add manual test plan for microphone permissions and provider disconnects.

## Proposed PR Breakdown

### PR 1: Voice Capability Foundation

Scope:

- Add speech and realtime capability types/catalogs.
- Add auto vs user default-resolution helpers.
- Add app/provider capability gating helpers.
- Add settings type fields without changing visible UI yet.
- Add unit tests for default resolution and invalid user defaults.

Non-goals:

- No read-aloud commands.
- No settings redesign.
- No provider API calls.
- No live voice UI.

Why this PR exists:

- It creates the shared rules before UI and services depend on them.
- It keeps the most error-prone conflict logic small and testable.

### PR 2: Voice Settings Mockup

Scope:

- Add `docs/mockups/voice-audio-settings.html`.
- Show one Defaults tab `Voice` section.
- Put Voice input, Read aloud, and Live voice settings inside that section.
- Include auto/user default states.
- Include invalid selected default state.
- Include locked/unlocked app-backed provider examples.
- Include mobile layout.
- Avoid speed/style controls, configured capability panels, and default-resolution panels.

Non-goals:

- No production settings changes.

Why this PR exists:

- The settings state model is complex enough that it should be reviewed before wiring production controls.

### PR 3: Production Voice Settings

Scope:

- Add the production Voice section.
- Move transcription controls under Voice.
- Keep Ingestion focused on file conversion and OCR.
- Add read-aloud and live-voice controls with locked states.
- Persist `auto` vs `user` selection state.
- Keep internal capability/default resolution logic out of the visible settings UI unless a selected value needs repair.

Non-goals:

- No read-aloud command execution.
- No live voice session.
- No speed/style controls.

Why this PR exists:

- It makes settings real without also taking on audio playback/provider complexity.

### PR 4: Read-Aloud Core And First Provider

Scope:

- Add Markdown speech preprocessing.
- Add `SpeechSynthesisService`.
- Add one speech adapter.
- Add `ReadAloudService`.
- Add command, editor-menu, and file-menu entry points.
- Add basic start/stop playback.

Recommended first adapter:

- ElevenLabs if app-backed unlock behavior is the priority.
- OpenAI if provider-backed setup is simpler for first implementation.

Non-goals:

- No live voice.
- No multi-provider speech support unless needed for the first adapter abstraction.
- No audio export/save unless explicitly added.

Why this PR exists:

- It delivers the first user-visible value while still limiting provider surface area.

### PR 5: Unified Audio Tool Design

Scope:

- Decide whether to add a provider-aware `generateAudio` tool.
- Decide whether it should absorb current ElevenLabs audio tools.
- Define `mode: voice | music | sfx` unlock behavior.
- Define output behavior and whether `outputPath` is required.
- Define compatibility/deprecation path for app-specific ElevenLabs tools.

Non-goals:

- No live voice implementation.
- No production migration unless the design is settled.

Why this PR exists:

- A broad generated-audio tool changes the app/tool boundary and should not be hidden inside read-aloud work.

### PR 6: Additional Read-Aloud Providers

Scope:

- Add remaining speech adapters.
- Add provider-specific voice loading.
- Add provider-specific chunk/request limit handling.
- Add tests for provider selection and chunk planning.

Non-goals:

- No live voice implementation.

Why this PR exists:

- Provider APIs differ enough that adding all of them in PR 4 would obscure the core read-aloud behavior.

### PR 7: Live Voice UX Mockup And Technical Spike

Scope:

- Add live-mode chat mockup.
- Spike one realtime provider enough to validate:
  - microphone permissions
  - session start/stop
  - interruption behavior
  - audio output playback
  - transcript events
  - tool call compatibility
  - provider disconnect recovery

Non-goals:

- No production live voice session.
- No multi-provider implementation.

Why this PR exists:

- Realtime voice is a different product surface from read aloud. The unknowns are transport/session semantics, not just UI controls.

### PR 8: Live Voice V1

Scope:

- Implement one realtime provider adapter.
- Add chat live-mode controller.
- Add production live-mode UI.
- Persist transcript/tool-call events into the conversation model.
- Add cleanup for stop, disconnect, and provider errors.

Non-goals:

- No chained fallback.
- No second realtime provider unless the first adapter abstraction is stable.

Why this PR exists:

- This is the first complete realtime feature and should be reviewable on its own.

### PR 9: Additional Realtime Providers

Scope:

- Add Google Gemini Live and/or ElevenLabs realtime after PR 8 proves the abstraction.
- Add provider-specific settings and tests.

Non-goals:

- No redesign of read-aloud or transcription settings unless required by provider compatibility.

## Testing Plan

Unit tests:

- frontmatter stripping
- Markdown cleanup
- TTS chunk planning
- provider/model default resolution
- app-enabled gating
- realtime lock/unlock rules
- no chained live-voice fallback path

Integration/manual tests:

- Read selected text aloud.
- Read active note aloud with frontmatter skipped.
- Read file from file menu.
- Stop playback mid-note.
- Disable speech provider and verify read-aloud controls lock.
- Enable ElevenLabs app and verify read-aloud model picker unlocks.
- Verify live voice remains locked for TTS-only providers.
- Verify live voice unlocks only for realtime-capable provider/app.

## Risks And Follow-Ups

- Provider text limits may force chunking that affects narration continuity.
- Voice lists may be dynamic and account-specific, especially for ElevenLabs.
- Realtime provider APIs have different transport/session models.
- Live voice persistence may need a dedicated transcript-event mapping layer.
- Obsidian mobile support depends on browser audio APIs and provider CORS/auth constraints.
- Secrets API migration may affect how voice provider credentials should be stored later.

## Edge Cases

### Settings And Defaults

- Multiple providers are enabled before the user picks a default.
- A provider is added after auto mode already resolved a default.
- A user-selected provider is disabled.
- A user-selected app is uninstalled.
- A user-selected model or voice disappears from a refreshed provider model list.
- A provider validates successfully but lacks the specific TTS or realtime permission.
- An app is installed but not enabled.
- An app is enabled but missing credentials.
- Credentials are changed while a settings modal is open.
- Settings are synced across devices where one device lacks the provider/app.
- Mobile shows a setting for a provider that only works on desktop.

### Read Aloud Text Handling

- Note has YAML frontmatter only.
- Note has malformed frontmatter delimiters.
- Note is extremely long and requires many chunks.
- Note contains code fences, Dataview blocks, callouts, tables, footnotes, embeds, images, headings, tasks, and block references.
- Selection spans partial Markdown syntax.
- Active file is not Markdown.
- File was deleted or renamed while read aloud is starting.
- Reading a note with no meaningful text after preprocessing.
- User starts read aloud while another playback is active.
- User changes voice/model while playback is active.
- Provider returns partial audio then fails.
- Provider supports streaming audio but browser playback cannot start because of autoplay/audio-context restrictions.
- Obsidian mobile or desktop denies audio output permissions.

### Live Voice

- Microphone permission denied.
- No input device is available.
- Audio output device changes during a session.
- Provider session expires mid-conversation.
- Network disconnects mid-session.
- User switches chat, workspace, or model while live mode is active.
- User closes the chat leaf while live mode is active.
- User starts a tool call during live mode and the provider expects a tool result.
- Provider emits transcript deltas that differ from final transcript text.
- Provider supports interruption/barge-in differently than other providers.
- Realtime model does not support the same tool-calling shape as normal text chat.
- A voice session produces assistant audio but no text transcript.
- Session usage/cost reporting differs from normal LLM usage.

### Storage And Persistence

- Read-aloud should not create conversation messages unless explicitly requested.
- Live voice should persist enough transcript content to make the conversation recoverable.
- Tool traces from live voice must remain searchable and displayable.
- Partial live turns need a clear stored state if the session ends abruptly.
- Audio bytes should not be stored by default unless a save/export option exists.

## Open Questions

- Should read aloud save generated audio to the vault optionally, or only play it?
- Should code blocks be skipped, summarized, or read verbatim?
- Should read aloud use active note language detection or leave language entirely to provider auto-detection?
- Should app-backed speech providers appear in Defaults, Apps, or both?
- Should live voice settings be visible-but-locked or hidden until a realtime provider is configured?
- Should auto defaults be allowed to switch when a higher-priority provider becomes configured, or should first auto resolution stick until reset?
- Should live voice require an explicit per-chat toggle, a global default, or both?
