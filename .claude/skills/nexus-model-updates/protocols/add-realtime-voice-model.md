# Protocol: add-realtime-voice-model

Context: a provider shipped a *Live* / *Realtime* model — Google `gemini-*-live*`,
OpenAI `gpt-realtime*`, and their kin. These ids answer only over a
bidirectional WebSocket session (`bidiGenerateContent`, OpenAI Realtime). They
are not chat models: `generateContent` / chat completions returns HTTP 400 for
them, so a row in `<Provider>Models.ts` is a picker entry that always errors,
the structural gate never sees it, and the provider smoke lane cannot prove it.

## Mission
A realtime voice catalog entry whose transport shape is proven against the live
socket through the shipped session class, with any per-model setup requirement
(thinking level, modalities) encoded in the declaration rather than remembered.

## Where things live
- Catalog: `src/services/llm/types/RealtimeVoiceTypes.ts` — `REALTIME_VOICE_MODELS`,
  a `RealtimeVoiceModelDeclaration` per model. **Order matters:** a provider's
  auto-selected default is the first entry for that provider
  (`resolveDefaultRealtimeVoiceSelection` takes `models[0]`).
- Sessions: `src/services/realtimeVoice/<Provider>RealtimeVoiceSession.ts` — a
  browser-native `WebSocket` (or WebRTC for OpenAI). No `requestUrl`, no Node
  `ws`; this is why the path works on mobile.
- Request resolution: `src/services/realtimeVoice/RealtimeVoiceService.ts` —
  turns settings + declaration into the resolved request the session sends.
- Settings picker reads the catalog (`ChatSettingsRenderer`, `DefaultsTab`), so
  a new entry appears in the UI with no UI change.

## Steps

1. **Confirm the id is realtime-only before choosing the catalog.** Ask the
   provider's endpoint, not the announcement. Google's model resource says it
   outright; AssemblyAI's streaming socket and batch `speech_models` both
   enumerate every accepted id in their validation error when sent a bogus
   one — the cheapest complete listing there is, and the two sets differ
   (`universal-3-pro` is batch-only; `universal-3-6*` is streaming-only).
   Batch transcription ids live in `src/services/llm/types/VoiceTypes.ts`,
   not this catalog.

   ```bash
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/<id>" \
     -H "x-goog-api-key: $GEMINI_API_KEY" | grep -A3 supportedGenerationMethods
   ```

   `["bidiGenerateContent"]` alone → this protocol. If `generateContent` is also
   listed, it is a chat model and belongs in `add-model.md` instead.

2. **Read the neighbouring entry for the same provider** and copy its
   conventions: `transport`, `execution` (`native-agent` owns the whole
   conversation; `transcription-pipeline` only transcribes and Nexus chat
   answers), `defaultVoice` and the shared voice list.

3. **Find the setup-frame requirements — they differ per model in the same
   family.** The failure surfaces as a WebSocket close with code 1007 *before*
   `setupComplete`, not as an error on the first turn. Known shapes:

   - A model that **requires** `generationConfig.thinkingConfig.thinkingLevel`
     (Gemini 3.8 Live Extended Thinking: `low`/`medium`/`high`, `minimal`
     rejected) — declare `thinkingLevelFloor`. `RealtimeVoiceService` then
     translates the app-wide `defaultThinking.effort` exactly as the chat adapter
     maps Gemini 3, and "thinking off" lands on the floor.
   - A model that **rejects** `thinkingConfig` entirely (Gemini 3.8 Live) —
     leave `thinkingLevelFloor` unset. The session omits the field.

   Do not guess which of the two a new id is. Probe it (step 5) with and without
   the field and read the close reason.

4. **Write the entry**, placed so the provider's default is the one users
   should land on. Keep a superseded preview id if users may have it saved:
   removing it turns their stored selection `invalid` rather than migrating it.

5. **Prove it through the shipped session, not a hand-rolled socket.** The
   realtime smoke lane constructs the real `RealtimeVoiceService`, runs the real
   session over a real socket, and fakes only the microphone and speaker. It
   sweeps every Google catalog entry, and every thinking level for entries with
   a floor:

   ```bash
   RUN_REALTIME_VOICE_SMOKE=1 npx jest tests/debug/realtime-voice-google-live-smoke.test.ts \
     --runInBand --no-coverage --verbose
   ```

   For AssemblyAI (transcription pipeline) the sibling lane synthesizes a
   phrase with macOS `say`, pumps it through the session's own capture
   callback, and requires the finalized transcript to contain it:

   ```bash
   RUN_REALTIME_VOICE_SMOKE=1 npx jest tests/debug/realtime-voice-assemblyai-live-smoke.test.ts \
     --runInBand --no-coverage --verbose
   ```

   Both lanes refuse an id that is not in the catalog (the service marks it
   `invalid`), so to vet a candidate add the row first and let the lane decide
   whether it stays. An id can be accepted at connect and still be dead:
   `universal-3-7-preview` opened a session and then cancelled it.

   Pin one target with `REALTIME_VOICE_SMOKE_MODEL=<id>` and
   `REALTIME_VOICE_SMOKE_THINKING=low|medium|high|off`. It reads
   `GEMINI_API_KEY` from the environment or the repo-root `.env`; run from the
   repo root. A pass means: setup accepted, `listening` reached, a text turn
   produced audio chunks the session decoded plus a completed transcript, and no
   `onError`. Six targets take ~25 s; if a run appears to hang for minutes, it is
   the `rtk` wrapper buffering — rerun through `rtk proxy` for live output.

6. **Unit lane.** `tests/unit/VoiceAudioCapabilityTypes.test.ts` asserts the
   provider default and declaration flags; `tests/unit/RealtimeVoiceService.test.ts`
   asserts the effort translation; `tests/unit/GoogleRealtimeVoiceSession.test.ts`
   asserts the setup frame. A moved default fails the first one loudly — update
   the expectation, do not relax it.

## Guidelines
- Pattern: one model per probe. A family launch with two ids had opposite
  `thinkingConfig` rules; a batched probe would have blamed the wrong one.
- Pattern: encode a setup requirement as a declaration field the service reads,
  never as an id-substring check in the session.
- Anti-pattern: reporting an id as working because the raw WebSocket probe
  returned audio. That proves the provider; only the smoke lane proves the
  session's own setup frame, transcript callbacks and state machine.
- Anti-pattern: adding a realtime id to `<Provider>Models.ts` "so it shows up
  in the model picker". It will show up, and every send will 400.

## Next
`self-refine.md` at the end of the session. If the new entry changed which
model a provider auto-selects, say so in the changelog entry: users who never
picked a voice model will start hearing a different one.
