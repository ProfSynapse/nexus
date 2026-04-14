# Implementation Plan: Mobile Chat Voice Input

> Created on 2026-04-14
> Status: SCOPED
> Base branch: `feat/mobile-chat-glass-phase1`
> Scope branch: `codex/mobile-chat-glass-voice-input-scope`

## Summary

Add a mic-first composer mode to `ChatView` when:

- a conversation is active
- the chat input is empty
- chat is not currently compacting or stopping generation
- transcription is configured and actually usable on the device

In that state, the current `arrow-up` send button becomes a microphone. Tapping it starts microphone capture and chunk-based transcription. While capture is active, the composer stops looking like a text box and becomes a glass-styled voice surface with a simple animated bar treatment instead of a literal waveform. Tapping stop closes the mic, waits for the queued chunk transcriptions to settle, writes the merged text into the existing composer, and restores the normal send button. Any typed text should always win over voice mode and immediately switch the control back to send.

This plan is scope only. No production code changes are included here.

## Existing repo context

Relevant code already exists for the backend half:

- `src/services/llm/TranscriptionService.ts`
- `src/services/llm/types/VoiceTypes.ts`
- `src/settings/tabs/DefaultsTab.ts`

Relevant UI seams already exist for the composer half:

- `src/ui/chat/components/ChatInput.ts`
- `src/ui/chat/ChatView.ts`
- `tests/unit/ChatInputPreSendCompactionIndicator.test.ts`

Important constraint: the repo already supports provider-backed transcription for ingest and audio tooling, but the chat composer has no microphone capture/session controller today. The missing work is the browser capture layer, session state machine, and UI state orchestration.

## UX contract

### State precedence

Recommended precedence for the composer button:

1. No conversation selected: current disabled state stays unchanged.
2. Pre-send compaction: current disabled state stays unchanged.
3. Assistant turn actively streaming with empty input: current stop-generation square stays unchanged.
4. Any non-empty draft text: current send arrow stays unchanged.
5. Empty draft + usable voice input: microphone icon.
6. Empty draft + unusable voice input: current empty send state, no mic affordance.

### Voice flow

1. User sees microphone when the composer is empty.
2. User taps mic.
3. Permission is requested if needed.
4. Composer flips into recording mode:
   - non-editable voice surface
   - animated bar treatment
   - stop button replaces mic
   - short status copy like `Listening and transcribing`
5. Recorder emits blobs on a fixed cadence.
6. Each blob is transcribed sequentially through the existing `TranscriptionService`.
7. User taps stop.
8. Recorder closes, outstanding chunk jobs drain, partial texts are merged, whitespace is normalized.
9. Merged text is written into the existing contenteditable composer.
10. Button becomes send arrow because the draft is now non-empty.

### Typed text rule

Typed text must always take priority over the mic affordance:

- if the user types into an empty composer, mic becomes send immediately
- if the user clears the composer again and voice input is available, send becomes mic again
- while recording, the text field should not remain editable

## Architecture recommendation

### 1. Keep capture/transcription logic out of `ChatView`

`ChatView` should remain mostly unchanged. The feature is local to the composer.

Recommended split:

- `ChatInput.ts`: render logic, DOM state toggles, button routing, final `setValue()`
- new `src/ui/chat/controllers/ChatVoiceInputController.ts`: microphone session lifecycle
- optional new `src/ui/chat/types/ChatVoiceInputTypes.ts`: state and session result types

### 2. Do not replace the existing `.chat-textarea` node

`ChatInput` already owns suggesters and contenteditable helpers. Replacing the DOM node would create unnecessary churn.

Recommended approach:

- keep the existing `.chat-textarea`
- add a sibling voice overlay inside `.chat-input-wrapper`
- toggle visibility with classes such as `chat-input-voice-recording` / `chat-input-voice-transcribing`
- when recording ends, write transcript into the existing contenteditable node with `ContentEditableHelper.setPlainText()`

### 3. Capability gating should be explicit

The mic should not appear based on settings alone. It should require all of:

- configured default transcription provider/model, or a resolvable fallback from `TranscriptionService`
- enabled provider with API key
- `navigator.mediaDevices.getUserMedia`
- `MediaRecorder`
- at least one supported recording MIME type

Recommended helper shape:

- `ChatVoiceInputController.getAvailability(): { available: boolean; reason?: string }`

## Recording and transcription pipeline

### Capture

Recommended v1 capture path:

- `getUserMedia({ audio: true })`
- `MediaRecorder` with best-supported MIME chosen in order:
  - `audio/webm;codecs=opus`
  - `audio/webm`
  - `audio/mp4`
- timeslice around `2000` to `3000` ms

This is enough to satisfy the requested “recording/transcribing in chunks” behavior without inventing a separate streaming API.

### Queueing

Recommended controller behavior:

- recorder blobs go into a FIFO queue
- only one transcription request runs at a time
- each completed chunk appends to an in-memory transcript parts array
- stop does not resolve until the queue is drained

Suggested internal state:

- `idle`
- `recording`
- `stopping`
- `transcribing-final`
- `error`

### Transcript merge

Recommended v1 merge behavior:

- join chunk texts with single spaces
- collapse repeated whitespace
- trim final output

Known limitation:

- chunk boundaries can cut across words or sentences depending on recorder timing and provider behavior

Recommendation:

- accept that limitation for v1
- keep chunk windows a bit longer rather than shorter
- do not add a second full-file “cleanup pass” in v1 because it doubles transcription cost

If quality proves rough in practice, the follow-up is a bounded optional final reconcile pass for short recordings only.

## UI states to implement

### Empty + voice available

- button icon: `mic`
- placeholder: `Speak or type your message...`
- normal contenteditable remains visible

### Recording

- button icon: stop square
- composer becomes voice shell
- contenteditable hidden visually, not destroyed
- animated bars, not a literal waveform
- short copy:
  - `Listening and transcribing`
  - `Chunk 3 captured`

### Stop/drain/finalize

- button disabled
- voice shell remains visible
- copy shifts to something like `Finalizing transcript`

### Draft restored

- contenteditable becomes visible again
- transcript text inserted
- button icon returns to `arrow-up`

### Error

- return to normal text composer
- preserve any partial transcript if available
- show `Notice` with the failure reason

## Proposed production file touch points

Primary files:

- `src/ui/chat/components/ChatInput.ts`
- `src/ui/chat/ChatView.ts`
- `styles.css`

New files:

- `src/ui/chat/controllers/ChatVoiceInputController.ts`
- `src/ui/chat/types/ChatVoiceInputTypes.ts`

Possible helper file if MIME selection feels noisy:

- `src/ui/chat/utils/voiceRecordingSupport.ts`

## Styling notes

Production styling must stay in `styles.css`.

Recommended class additions:

- `.chat-input-voice-enabled`
- `.chat-input-voice-recording`
- `.chat-input-voice-transcribing`
- `.chat-input-voice-shell`
- `.chat-input-voice-wave`
- `.chat-input-voice-bar`
- `.chat-send-button.voice-mode`
- `.chat-send-button.voice-stop-mode`

The visual treatment should match the glass branch:

- same color tokens
- same softened border language
- no literal audio waveform dependency
- motion that respects `prefers-reduced-motion`

## Testing plan

Unit coverage to add:

- mic icon only appears when input is empty and voice input is available
- typed text immediately flips mic back to send
- loading / stop-generation state still overrides mic mode
- starting voice capture moves UI to recording state
- stopping waits for queued chunk work, then fills the composer
- permission denial falls back cleanly
- transcription failure preserves partial text and exits recording mode

Likely test files:

- extend `tests/unit/ChatInputPreSendCompactionIndicator.test.ts`
- add `tests/unit/ChatVoiceInputController.test.ts`

Manual checks:

- iOS mobile app / WebView behavior
- Android mobile behavior
- desktop behavior with no recorder support or no transcription config

## Risks

- `MediaRecorder` MIME support varies across platforms, especially iOS.
- Chunked STT can produce awkward boundaries.
- Recording and assistant stop-generation both want the same square icon, so state precedence must remain strict.
- The current composer is contenteditable with suggesters attached; swapping DOM nodes is riskier than toggling a sibling overlay.

## Recommendation

This is a reasonable phase-2 follow-up on the mobile glass work. The feature should be implemented as a composer-local controller and overlay, not as a `ChatView` orchestration feature. That keeps the change set small, preserves the current send/stop behavior, and lets the transcription stack already present in the repo do the heavy lifting.
