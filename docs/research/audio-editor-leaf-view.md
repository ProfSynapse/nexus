# Audio Editor Leaf View — Research & Architecture

**Date**: 2026-04-04
**Status**: Research / Proposal
**Related**: ComposerAgent (`src/agents/apps/composer/`), TaskBoardView (`src/ui/tasks/TaskBoardView.ts`)

---

## 1. Goal

Build a visual audio editor as an Obsidian workspace leaf view (like the Task Board) that:
- Renders waveforms with interactive timeline, regions, and transport controls
- Supports cut, trim, split, fade, mix, and effects operations via the UI
- Exposes the same operations as LLM-callable tools (so the ComposerAgent / a new AudioEditorAgent can manipulate audio programmatically)
- Integrates with existing vault audio files and the Composer's audio pipeline

---

## 2. Existing Patterns to Follow

### 2.1 Task Board Leaf View Pattern

The Task Board (`src/ui/tasks/TaskBoardView.ts`) establishes the pattern:

| Concern | Implementation |
|---------|---------------|
| **View class** | `TaskBoardView extends ItemView` |
| **View type constant** | `TASK_BOARD_VIEW_TYPE = 'nexus-task-board'` |
| **Registration** | `TaskBoardUIManager` calls `plugin.registerView()` early (before workspace restore), then registers an "Open task board" command |
| **Service access** | `ensureServices()` polls with retry (up to 40 attempts × 750ms) for plugin services to be ready |
| **DOM rendering** | Pure Obsidian DOM API: `createDiv()`, `createEl()`, `registerDomEvent()` — no framework |
| **State persistence** | `getState()` / `setState()` serialize view state (filters, active workspace) |
| **Real-time sync** | Event bus (`TaskBoardEvents.onDataChanged`) triggers re-render; deferred sync during edit/drag |
| **Lazy loading** | Dynamic `import()` of the view class to avoid loading at startup |

**Audio Editor would mirror this**: `AudioEditorView extends ItemView`, registered by `AudioEditorUIManager`, with its own view type constant and command.

### 2.2 Existing Audio Pipeline (ComposerAgent)

The Composer already has a solid audio backend:

- **AudioComposer.ts** — Orchestrates concat/mix via Web Audio API
- **AudioMixer.ts** — Multi-track mixing with per-track volume, offset, fade-in/out via `GainNode` + `OfflineAudioContext`
- **AudioEncoder.ts** — WAV (PCM), MP3 (wasm-media-encoders), WebM/Opus (MediaRecorder)
- **FileReader.ts** — Vault path validation and binary reading

These services can be reused directly. The audio editor adds **visual interaction** and **non-destructive editing state** on top.

---

## 3. Open-Source Library Evaluation

### 3.1 Waveform Visualization

#### wavesurfer.js (Recommended for primary waveform rendering)
- **GitHub**: 10.1k stars, actively maintained (v7.12.1, last published ~Mar 2026)
- **License**: BSD-3-Clause
- **Key features**: Interactive waveform rendering, zoom/scroll, region/marker plugins, spectrogram plugin, Web Audio API backend, Shadow DOM isolation (v7+)
- **Plugins**: Regions (segment selection/editing), Timeline, Minimap, Spectrogram, Record, Envelope
- **Bundle**: ~30KB min+gzip (core), plugins are separate
- **Electron/Obsidian fit**: Excellent — pure Web Audio API + Canvas/SVG rendering, no server dependency. Shadow DOM isolates styles from Obsidian's CSS.
- **LLM-tool fit**: Programmatic API for all operations (`addRegion()`, `seekTo()`, `zoom()`, `setPlaybackRate()`)

#### peaks.js (BBC) — Strong alternative
- **GitHub**: 3.3k stars, actively maintained (v4.0.0-beta.2)
- **License**: LGPL-3.0
- **Key features**: Dual-view (overview + zoom), segment/point markers, pre-computed waveform data support, Konva.js canvas rendering
- **Designed for**: Broadcast editing workflows (BBC World Service Radio Archive)
- **Peer deps**: Konva.js, waveform-data.js
- **Trade-offs**: More complex setup, heavier total bundle, LGPL license (more restrictive). Better for long-form audio (pre-computed waveforms avoid re-decoding). Dual-view is great for podcast/long audio editing.

#### Verdict
**wavesurfer.js** for primary visualization — lighter, more active community, BSD license, plugin ecosystem covers our needs. Consider peaks.js if long-form audio (>30 min) becomes a priority (pre-computed waveforms are more efficient at scale).

### 3.2 Audio Processing / Effects

#### Tone.js
- **GitHub**: ~13k stars, actively maintained
- **License**: MIT
- **Key features**: Full DAW-style transport, effects chain (reverb, delay, chorus, EQ, compressor, distortion, etc.), synthesis, scheduling, sample playback
- **Bundle**: ~150KB min+gzip (tree-shakeable)
- **Electron fit**: Built on Web Audio API, works great in Electron
- **LLM-tool fit**: Highly programmable — `new Tone.Reverb({ decay: 2.5 })`, `player.connect(effect)`, `Tone.Transport.schedule()`

#### Web Audio API (native)
- Already used by AudioComposer/AudioMixer — GainNode, OfflineAudioContext, decodeAudioData
- Sufficient for: volume, panning, basic gain envelopes, mixing
- Not sufficient for: reverb, EQ, time-stretching, pitch-shifting (need AudioWorklet or Tone.js)

#### ffmpeg.wasm
- **License**: LGPL/GPL
- **Bundle**: ~25MB WASM core (very heavy)
- **Use case**: Format conversion, complex re-encoding, time-stretching
- **Trade-off**: Too heavy for an Obsidian plugin. Better to use native Web Audio + Tone.js for processing and wasm-media-encoders (already in project, ~200KB) for encoding.

#### Verdict
**Tone.js** for effects processing — tree-shakeable, rich effects library, MIT license. Keep the existing Web Audio API approach for basic operations (concat, mix, fade). Skip ffmpeg.wasm (too heavy).

### 3.3 DAW-like UI / Multi-track Timeline

#### waveform-playlist (naomiaro)
- **GitHub**: ~1.2k stars
- **License**: MIT
- **Key features**: Multi-track audio editor UI, timeline with cursor, track-level volume/pan/solo/mute, region selection, fade curves, non-destructive edits, export to AudioBuffer
- **Built on**: Web Audio API + wavesurfer-like canvas rendering
- **Trade-offs**: Less maintained than wavesurfer.js, but provides the closest thing to a "drop-in DAW UI"

#### Build custom with wavesurfer.js
- wavesurfer.js Regions plugin + custom track layout = multi-track editor
- More work but more control over Obsidian integration
- Each track = one wavesurfer instance stacked vertically with synchronized playback

#### Verdict
**Two viable approaches**:

1. **Quick path**: Use **waveform-playlist** as a starting point — it already has multi-track timeline, transport controls, and region editing. Style it to match Obsidian.
2. **Custom path**: Build multi-track on top of **wavesurfer.js** — more control, better long-term maintainability, aligns with Obsidian's DOM API patterns.

**Recommendation**: Start with **wavesurfer.js + custom track layout** for v1. The Task Board pattern shows that manual DOM management with Obsidian APIs works well. We can build a track container that hosts multiple wavesurfer instances with a shared transport.

---

## 4. Proposed Architecture

### 4.1 File Structure

```
src/
├── agents/apps/audioEditor/
│   ├── AudioEditorAgent.ts          # Agent class (extends BaseAppAgent)
│   ├── types.ts                      # Edit operations, track state, project types
│   ├── tools/
│   │   ├── openEditor.ts            # Open the leaf view with a file/project
│   │   ├── addTrack.ts              # Add audio track from vault file
│   │   ├── removeTrack.ts           # Remove track
│   │   ├── trimRegion.ts            # Trim to selected region
│   │   ├── splitAt.ts               # Split track at time position
│   │   ├── applyEffect.ts           # Apply effect (reverb, EQ, fade, etc.)
│   │   ├── setTrackVolume.ts        # Per-track volume/pan
│   │   ├── exportMix.ts             # Render and save to vault
│   │   └── getEditorState.ts        # Read current editor state (for LLM context)
│   └── services/
│       ├── AudioEditorState.ts      # Non-destructive edit list / project state
│       ├── AudioEditorRenderer.ts   # Waveform rendering (wraps wavesurfer.js)
│       ├── EffectsChain.ts          # Tone.js effects pipeline
│       └── TransportController.ts   # Shared playback transport
├── ui/audioEditor/
│   ├── AudioEditorView.ts           # ItemView subclass
│   ├── AudioEditorToolbar.ts        # Transport controls, zoom, tools
│   ├── TrackContainer.ts            # Multi-track layout manager
│   ├── TrackRow.ts                  # Single track: waveform + controls
│   └── EffectsPanel.ts             # Effects configuration UI
├── core/ui/
│   └── AudioEditorUIManager.ts      # View registration + commands
```

### 4.2 Non-Destructive Edit Model

The editor maintains an **edit decision list (EDL)** — a sequence of operations applied to source audio:

```typescript
interface AudioProject {
  id: string;
  name: string;
  tracks: Track[];
  edits: EditOperation[];      // Ordered list of non-destructive edits
  transport: TransportState;   // Current playhead position, loop region
}

interface Track {
  id: string;
  sourceFile: string;          // Vault path to source audio
  volume: number;              // 0.0 - 1.0
  pan: number;                 // -1.0 (L) to 1.0 (R)
  mute: boolean;
  solo: boolean;
  offset: number;              // Start time in timeline (seconds)
  regions: Region[];           // Visual markers / selections
}

interface EditOperation {
  type: 'trim' | 'split' | 'fade-in' | 'fade-out' | 'effect' | 'volume' | 'move' | 'delete-region';
  trackId: string;
  params: Record<string, unknown>;
  timestamp: number;           // When the edit was made (for undo)
}
```

This model is:
- **Serializable** — can be saved as JSON in `.nexus/audio-projects/`
- **LLM-friendly** — tools push operations to the EDL, view re-renders
- **Undoable** — pop operations from the edit list
- **Event-sourced** — matches the JSONL pattern used elsewhere in Nexus

### 4.3 LLM Tool Integration

Tools call the same `AudioEditorState` service that the UI uses:

```
LLM Tool (e.g., applyEffect)
  → AudioEditorState.pushEdit({ type: 'effect', trackId, params: { effect: 'reverb', decay: 2.5 } })
    → EventBus.emit('editor:edit-applied')
      → AudioEditorView re-renders affected track
```

The `getEditorState` tool gives the LLM full context:
- Track list with file paths, durations, volume/pan settings
- Current edit list
- Selected region (if any)
- Transport position

This lets the LLM reason about the current state and issue precise edit commands.

### 4.4 Rendering Flow

```
AudioEditorView.onOpen()
├── renderToolbar()         → play/pause/stop, zoom slider, undo/redo, export button
├── renderTrackContainer()  
│   └── for each track:
│       └── TrackRow
│           ├── Track controls (volume slider, pan knob, mute/solo, name)
│           └── WaveSurfer instance (waveform + regions)
│               ├── Regions plugin (for selections, fade markers)
│               └── Timeline plugin (shared time ruler)
└── renderEffectsPanel()    → expandable panel for applying effects to selected track
```

All wavesurfer instances share a single `TransportController` that synchronizes play/pause/seek across tracks.

### 4.5 Data Flow

```
                    ┌─────────────────┐
                    │  AudioEditorView │ (UI - ItemView)
                    │  ┌─────────────┐│
                    │  │ wavesurfer×N ││  ← renders waveforms
                    │  └──────┬──────┘│
                    └─────────┼───────┘
                              │ user interactions
                              ▼
                    ┌─────────────────┐
                    │AudioEditorState │  ← single source of truth
                    │  (edit list)    │
                    └────────┬────────┘
                             │ events
                    ┌────────┴────────┐
                    │                 │
              ┌─────▼─────┐   ┌──────▼──────┐
              │  UI View   │   │  LLM Tools  │
              │ re-render  │   │ (read/write │
              │            │   │  state)     │
              └────────────┘   └─────────────┘
                                     │
                              ┌──────▼──────┐
                              │ exportMix   │
                              │ → AudioComposer (existing)
                              │ → vault.createBinary()
                              └─────────────┘
```

---

## 5. Transcript-First Editing (Descript-Style)

### 5.1 Concept

Like Descript, the editor should support **transcript-driven editing** — where editing the text transcript automatically edits the underlying audio. The transcript becomes the primary editing surface:

- Select text in transcript → corresponding audio region is highlighted
- Delete a sentence from transcript → audio segment is removed (non-destructive)
- Rearrange paragraphs → audio segments reorder
- "Filler word removal" → auto-detect "um", "uh", "like" and offer one-click removal

### 5.2 Existing Infrastructure to Reuse

The **IngestManager** already has everything needed for transcription:

**TranscriptionService** (`src/agents/ingestManager/tools/services/TranscriptionService.ts`):
- OpenAI Whisper API (word-level timestamps via `verbose_json` response format)
- Groq speech-to-text (same Whisper API interface)
- Google Gemini multimodal audio understanding
- OpenRouter multimodal audio input
- Automatic chunking for files >25MB (`AudioChunkingService`)

**TranscriptionSegment** (`src/agents/ingestManager/types.ts`):
```typescript
interface TranscriptionSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}
```

This gives us time-aligned text segments. For Descript-style editing we'd need **word-level timestamps** — OpenAI Whisper's `verbose_json` format already provides these, we just need to surface them.

### 5.3 Provider Support Matrix

| Provider | Endpoint | Word Timestamps | Local | Notes |
|----------|----------|----------------|-------|-------|
| OpenAI | Whisper API | Yes (`timestamp_granularities[]=word`) | No | Best quality, most reliable word alignment |
| Groq | Whisper API | Yes (same interface) | No | Faster inference, same API |
| Google Gemini | Multimodal | Approximate (sentence-level) | No | Could prompt for timestamps but less precise |
| OpenRouter | Multimodal | Depends on model | No | Routes to various models |
| Local (Whisper.cpp) | N/A (future) | Yes | Yes | Could add via whisper-node or whisper.cpp WASM |

### 5.4 Transcript-Audio Alignment Data Model

```typescript
interface WordTimestamp {
  word: string;
  start: number;    // seconds
  end: number;      // seconds
  confidence?: number;
}

interface TranscriptTrack {
  trackId: string;
  words: WordTimestamp[];
  // Derived from words:
  paragraphs: TranscriptParagraph[];
}

interface TranscriptParagraph {
  startWordIndex: number;
  endWordIndex: number;
  text: string;           // Joined words
  startTime: number;
  endTime: number;
}

// Edit operations on transcript map to audio regions:
interface TranscriptEdit {
  type: 'delete-words' | 'move-words' | 'silence-words';
  startWordIndex: number;
  endWordIndex: number;
  // For move:
  targetIndex?: number;
}
```

### 5.5 UI Layout for Transcript-First Mode

```
┌─────────────────────────────────────────────────┐
│ [▶ Play] [⏸] [⏹]  🔊━━━━━  Zoom: ━━━○━━  │  ← toolbar
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ ▁▂▃▅▇▅▃▂▁▁▂▄▆▇▆▄▂▁▁▃▅▇▅▃▁▁▂▃▅▆▅▃▂▁     │ │  ← waveform (mini)
│ │          ◄══════════►                       │ │    with highlight
│ └─────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────┤
│                                                 │
│  So I was thinking about the project and, um,  │  ← transcript panel
│  we should really focus on the [um] core       │    (editable text)
│  features first. [uh] The audio editor needs   │    filler words marked
│  to be intuitive...                            │
│                                                 │
│  ▸ Paragraph 2 (0:45 - 1:12)                  │    collapsible paragraphs
│  ▸ Paragraph 3 (1:12 - 1:58)                  │
│                                                 │
├─────────────────────────────────────────────────┤
│ [Remove filler words (3)] [Export transcript]   │  ← action bar
│ [Re-transcribe] [Provider: OpenAI ▾]           │
└─────────────────────────────────────────────────┘
```

### 5.6 Implementation Approach

1. **Transcription step**: When audio is loaded, optionally run transcription via existing `TranscriptionService` (user picks provider from configured API keys)
2. **Word alignment**: Request word-level timestamps from Whisper (`timestamp_granularities[]=word`). For providers that don't support word-level, fall back to sentence-level segments.
3. **Bidirectional sync**: 
   - Click word in transcript → waveform seeks to that position, region highlights
   - Select region in waveform → corresponding words highlight in transcript
   - Cursor follows playback in both views
4. **Transcript edits → audio edits**: Deleting/moving text in transcript creates `EditOperation` entries that map word indices to time ranges
5. **Non-destructive**: All edits are stored in the EDL. Original audio + transcript are preserved. Export renders the final output.

### 5.7 LLM Integration for Transcript Editing

This is where the LLM integration becomes powerful:

```
User: "Clean up this podcast episode — remove all filler words and long pauses"
LLM → getEditorState (reads transcript + word timestamps)
LLM → identifies filler words ("um", "uh", "like", "you know") and pauses >2s
LLM → trimRegion (for each filler/pause, non-destructively removes the segment)
LLM → "Removed 23 filler words and 8 long pauses. Total time saved: 47 seconds."
```

Or more creative:
```
User: "Move the section about 'core features' to the beginning"
LLM → getEditorState (reads full transcript)
LLM → identifies paragraph boundaries for the "core features" section
LLM → moveRegion operations to rearrange audio segments
```

---

## 6. Library Dependency Summary (unchanged from above)

| Library | Purpose | License | Size | Status |
|---------|---------|---------|------|--------|
| **wavesurfer.js** v7 | Waveform rendering, regions, timeline | BSD-3 | ~30KB gzip | Active (10.1k stars) |
| **Tone.js** | Effects processing (reverb, EQ, etc.) | MIT | ~150KB gzip (tree-shakeable) | Active (~13k stars) |
| wasm-media-encoders | MP3 encoding (already in project) | MIT | ~200KB | Already a dependency |

**Not recommended**:
- ffmpeg.wasm — 25MB WASM, too heavy for Obsidian plugin
- howler.js — Playback-focused, no editing features (23.7k stars but wrong use case)
- pizzicato.js — Thin Web Audio wrapper, Tone.js is more comprehensive

**Deferred evaluation**:
- peaks.js — Consider for v2 if long-form audio (>30 min) needs pre-computed waveforms (LGPL license is a concern)
- waveform-playlist — Could accelerate v1 but less control; revisit if custom multi-track is too much effort

---

## 6. Implementation Phases

### Phase 1: Single-Track Editor + Transcript (MVP)
- `AudioEditorView` leaf view with single wavesurfer instance
- Basic transport (play/pause/stop/seek)
- Region selection + trim/split operations
- Fade-in/out via wavesurfer Envelope plugin
- **Transcript panel**: Optional transcription via existing `TranscriptionService` (OpenAI/Groq/Google/OpenRouter)
- **Word-level timestamps** from Whisper API → bidirectional transcript-waveform sync
- Export to WAV/MP3 (reuse AudioEncoder), export transcript as markdown
- Tools: `openEditor`, `trimRegion`, `splitAt`, `exportMix`, `transcribe`

### Phase 2: Transcript-First Editing (Descript-style)
- Edit transcript text → non-destructive audio edits
- Filler word detection and one-click removal
- Silence/pause detection and removal
- Paragraph-level reordering
- Cursor-follows-playback in transcript view
- Tools: `removeFillerWords`, `moveRegion`, `getEditorState`

### Phase 3: Multi-Track + Mixing
- Track container with multiple wavesurfer instances
- Per-track volume/pan/mute/solo
- Track offset (positioning on timeline)
- Mix-down export (reuse AudioComposer/AudioMixer)
- Tools: `addTrack`, `removeTrack`, `setTrackVolume`

### Phase 4: Effects + Advanced Editing
- Tone.js effects chain (reverb, EQ, compressor, delay)
- Non-destructive effects preview (real-time audio routing)
- `applyEffect` tool with full effect parameter control
- Copy/paste regions across tracks
- Undo/redo stack

### Phase 5: LLM-Driven Workflows
- Prompt templates for common audio editing tasks ("clean up this podcast", "extract the segment about X")
- AI-suggested edit points (silence detection, beat detection, topic segmentation)
- Local Whisper model support (whisper.cpp WASM or whisper-node)

---

## 7. Obsidian-Specific Considerations

1. **Desktop only** — Web Audio API / OfflineAudioContext required (same as Composer audio)
2. **styles.css** — All waveform/track styles must go in `styles.css`, not inline. wavesurfer.js v7 uses Shadow DOM which helps isolate its internal styles, but our track layout and controls need to be in the global stylesheet.
3. **DOM events** — Use `this.registerDomEvent()` for all event listeners on wavesurfer containers (prevents memory leaks on view close)
4. **No innerHTML** — Use `createEl()` / `.textContent` for all dynamic content
5. **File access** — Use `vault.readBinary()` for audio loading, `vault.createBinary()` for export
6. **View cleanup** — wavesurfer instances must be destroyed in `onClose()` to free Web Audio resources

---

## 8. Open Questions

1. **Project persistence format**: JSONL (event-sourced, like workspaces) vs JSON (simpler, sufficient for small edit lists)?
2. **Audio caching**: Should decoded AudioBuffers be cached in memory or re-decoded on each view open?
3. **Real-time preview**: Should effects preview route through AudioContext in real-time, or render to OfflineAudioContext for preview?
4. **Spectrogram view**: wavesurfer.js has a spectrogram plugin — useful for speech/music editing. Include in v1 or defer?
5. **Drag-and-drop**: Support dragging vault audio files onto the editor to add tracks?
