# Read-Aloud: Save + Embed — Scoping / Design Doc

**Status:** Scoping (design only, no code). Future feature — NOT part of the in-flight release.
**Author:** PACT Architect
**Date:** 2026-06-08
**Related context:** Pre-release peer review of the readAloud / audio / Composer service families (architect Task #3).

---

## 1. Executive Summary

Today, "Read aloud" synthesizes a note (or a selection) chunk-by-chunk and **plays** the audio, then discards it. This feature adds an **opt-in** capability to also:

1. **Save** the synthesized audio to a user-visible folder in the vault, and
2. **Embed** an `![[...]]` audio player into the note.

There are two natural modes that already exist in the command surface — but they are the **same mechanism** (selection is just the N=1 case of whole-note):

| Mode | Source | Typical size | Embed location | Concat | Mobile? |
|------|--------|-------------|----------------|--------|---------|
| **Selection** | `editor.getSelection()` | usually 1 chunk (≤ ~3,600 chars) | after the selected block / at cursor | none (1 buffer) | **Yes** |
| **Whole-note** | `vault.cachedRead(file)` | many chunks (a 100K-word note → ~167 chunks) | top of note | **raw buffer join** (N → 1 file) | **Yes** |

**DECIDED (user, 2026-06-08):**
- **Single concatenated file is the only output mode.** A "playlist note" of N separate `![[chunk-NNN.mp3]]` embeds is rejected — the core use case is *listen to a whole note on a walk*, which requires one seamless file (one tap), not N players.
- **Do NOT use the Composer app for concat.** Composer is an installable App (coupling), is desktop-only (`OfflineAudioContext`), and its encoder emits only WAV/WebM (never mp3). All three break the mobile + single-file requirement.
- **Concat = raw format-aware `ArrayBuffer` join, no audio engine** (§4). Works identically on desktop and mobile.
- **Mobile is a first-class target for BOTH modes**, not desktop-only.
- **Trigger = explicit "Save as audio" action** (command + menu), separate from plain "read aloud now." Not an auto-on-play side effect.

**Slicing:** one mechanism, so selection and whole-note can ship together or selection-first as a thin start — but whole-note is no longer a "hard second slice," it's the same buffer-join path with N>1.

> ⚠️ **IMPLEMENTATION GUARDRAIL — storage path is SETTINGS-DERIVED, never hardcoded.** Every `Nexus/audio/` in this doc is the *default rendering* of `<rootPath>/<audioSubfolder>`. The literal string `Nexus` (or `Nexus/audio`) MUST NOT appear in code. Resolve at runtime: `rootPath = settings.settings.storage?.rootPath ?? DEFAULT_STORAGE_SETTINGS.rootPath` (precedent: `DataTab.ts:209`, `changeDataFolderPath.ts:67/82/100`), then join the configurable audio subfolder (default `'audio'`). The user changing their storage root MUST move where audio is saved. No `.nexus`, no hardcoded `Nexus`.

---

## 1b. v2 UX REDESIGN — supersedes the v1 trigger/feedback design (user manual-test feedback, 2026-06-08)

The v1 build (commits 89f65a8e CODE / f526adbc TEST) shipped **two separate explicit actions** ("Save selection/note as audio") that synthesized WITHOUT playback. Manual testing rejected that surface. The engine (`concatAudioBuffers`, settings-derived path, naming, embed-below-frontmatter) is RETAINED; the **trigger + feedback + playback coupling** is redesigned:

**DECIDED (user, 2026-06-08):**
1. **Unify to ONE action.** REMOVE the two separate "Save selection as audio" / "Save note as audio" commands AND their context/file-menu items. There is a single **"Read aloud"** entry (selection via editor context menu + palette; note via file ⋯ menu + palette). Save is no longer its own command.
2. **Save-prompt modal.** On invoking read-aloud → an Obsidian `Modal` asks **save-or-not** (e.g. [Save & read] / [Just read], + Cancel). This replaces the silent-synth behavior.
3. **Animated reading-aloud modal (either choice).** After the prompt, show a progress modal with a **live animation REUSED from the live-voice/transcript UI** (the pulsing dot `.chat-live-dot` + waveform bars `.chat-live-wave-bar` / `ChatInput.buildLiveVoiceBars`) so it's visually clear it's synthesizing/reading. These styles already carry `prefers-reduced-motion` handling (FE-MINOR-1) — reuse inherits it.
4. **Read-aloud now PLAYS.** This REVERSES the v1 "synth-only, no playback" decision. The action plays audio aloud; saving is captured ALONGSIDE playback (single synth pass — never double-synthesize: play + capture from the same synthesized buffers).
5. **Background-continue on dismiss (save case).** If Save was chosen and the user dismisses/leaves the modal: **playback STOPS, but synthesis + save CONTINUE in the background**, inserting the `![[...]]` embed when done. Implication: the save's synth pass must complete ALL chunks even after playback is cancelled mid-way (play until stopped, then synth-only for remaining chunks — one pass, no double-synth). If "Just read" was chosen, dismiss simply stops playback (nothing saved).

**Engine reuse (unchanged):** `concatAudioBuffers`, `ReadAloudSaveService` file-write + naming + sanitization + embed-below-frontmatter, settings-derived path. The capture source shifts from a synth-only pass to a **play-and-capture pass with cancellable playback but non-cancellable save**.

---

## 2. Current-State Ground Truth (verified)

| Fact | Location |
|------|----------|
| Read-aloud **chunks**, doesn't truncate. Splits at ~3,600-char sentence boundaries. | `MarkdownSpeechPreprocessor.ts:10` (`preprocess`) |
| `ReadAloudService.read()` synthesizes + **plays each chunk sequentially**, returns only `{ sourceName, chunkCount }` — **audio buffers are discarded**. | `ReadAloudService.ts:111-148` |
| Selection vs whole-note already branch in the command surface. | `ReadAloudCommandManager.ts:122-130` (`readSelection`), `:132-135` (`readFile`) |
| Selection command does NOT currently retain the editor reference past the read call (needed for embed insertion). | `ReadAloudCommandManager.ts:96` calls `readSelection(editor)` — editor is in scope, but not threaded to a save/embed step |
| Each adapter returns `{ audioData: ArrayBuffer, mimeType }`. | `SpeechSynthesisTypes.ts:22-28` (`SpeechSynthesisResult`) |
| `mimeType` differs by provider: most return `audio/mpeg` (mp3); **Google returns `audio/wav`** (PCM wrapped). | `OpenAISpeechAdapter.ts:62`, `GoogleSpeechAdapter.ts:88` |
| Existing single-buffer vault write with temp-swap overwrite + ensureParentDirectory. | `AudioGenerationService.writeAudio()` `AudioGenerationService.ts:93-114` |
| Embed pattern: `![[filename]]` produces an inline audio player. | `OutputNoteBuilder.buildAudioNote` `OutputNoteBuilder.ts:57-74` |
| Positional/prepend/append insert. `startLine=1` prepends, `-1` appends, N inserts at line N (1-based, pushes content down). | `ContentManager` `InsertTool` `insert.ts:82-115` |

### Storage root (CORRECTED ground truth — do NOT use `.nexus`)

The save folder must derive from the **settings-derived storage root**, not a hidden folder.

- **Field to pin:** `settings.settings.storage.rootPath` (type `MCPStorageSettings.rootPath`).
- **Definition + default:** `src/types/plugin/PluginTypes.ts:21` (field), `:29` (`DEFAULT_STORAGE_SETTINGS.rootPath = 'Nexus'`).
- **Default value origin:** `CONFIG.PLUGIN_NAME = 'Nexus'` (`src/config.ts:8`).
- **Runtime access precedent:** `settings.settings.storage?.rootPath` with fallback to `DEFAULT_STORAGE_SETTINGS.rootPath` — see `DataTab.ts:209` and `changeDataFolderPath.ts:67/82/100`.

So the audio output folder should be a subfolder of `rootPath`, e.g. `<rootPath>/audio/` (default `Nexus/audio/`), or a separately configurable subfolder (§3, open question Q3).

---

## 3. Requirements & The Two Modes

### 3.1 Selection mode (first slice)

- **Trigger:** existing `Read selection aloud` editor-menu item (`ReadAloudCommandManager.ts:91`), plus a new opt-in to save (setting or a second menu item — see Q1).
- **Audio:** selection is usually a single chunk → a single `SpeechSynthesisResult.audioData`. **No concat.**
- **Save:** write the single buffer via the existing `writeAudio` temp-swap pattern to `<rootPath>/<audioSubfolder>/`.
- **Embed location:** insert `![[<savedFile>]]` **after the selected block** (at the end-of-selection line) or at the cursor. Use the editor reference already in scope at `ReadAloudCommandManager.ts:96`. Direct `editor.replaceRange` at the selection's `to` position is the simplest in-plugin path; the MCP `InsertTool` is the alternative (positional, line-based).
- **Mobile:** fully supported — single buffer, `vault.createBinary`, no `OfflineAudioContext`.

### 3.2 Whole-note mode (second slice)

- **Trigger:** existing `Read note aloud` file-menu item / `read-active-note-aloud` command, plus the save opt-in.
- **Audio:** N chunks (up to ~167 for a large note) → N separate `audioData` buffers. **Concat required** to produce ONE embeddable file (§4).
- **Embed location:** `![[<savedFile>]]` at the **top of the note** (`InsertTool` `startLine=1`, or `vault.process` prepend).
- **Mobile:** concat is desktop-only (§4). Mobile must fall back (§4.4).

---

## 4. Concat — Raw Buffer Join (no audio engine, mobile-safe)

**DECISION:** concatenate the in-memory chunk buffers directly into one file, with a format-aware join. No `AudioContext`/`OfflineAudioContext`, no `MediaRecorder`, no Composer, no temp files, no re-encode. This is the only path that satisfies *mobile + single-file*.

**Why it works:** within a single read-aloud run, every chunk is synthesized by ONE provider at ONE bitrate/sample-rate/channel-mode, so the buffers are format-uniform and can be joined at the container level.

### 4.1 mp3 providers (OpenAI, ElevenLabs, and most others — `audio/mpeg`)

MP3 is a stream of self-contained frames; decoders play concatenated frame streams fine.

- **Join = byte-concatenate the `ArrayBuffer`s.** Pure JS, instant, small output, mobile-safe.
- **Nicety:** strip any leading **ID3v2** tag and **Xing/Info VBR header** frame from chunks 2…N so metadata/VBR headers don't land mid-stream. TTS output is typically raw CBR mp3 with no ID3, so this is often a no-op — but the strip makes it robust.
- **Known minor artifact:** the MP3 **bit reservoir** lets a frame reference up to ~2 prior frames' data; at a join boundary the first frame of chunk N+1 may reference reservoir bytes that aren't present → ~26ms of negligible artifact. **Inaudible for spoken word.** The only glitch-free alternative is decode+re-encode = the desktop-only/slow path we are deliberately rejecting.

### 4.2 Google (`audio/wav` — PCM wrapped in RIFF)

- **Join = header-aware:** keep chunk 1's RIFF/`fmt ` header, append only the PCM payload (bytes after each chunk's `data` sub-chunk header) from all chunks, then rewrite the `RIFF` size + `data` size fields. Pure JS, lossless, mobile-safe.
- **Tradeoff:** WAV is large (uncompressed PCM). Only Google hits this path; if file size matters, prefer an mp3 provider. (Future option: pipe Google PCM through a pure-JS mp3 encoder — out of scope for v1.)

### 4.3 Selecting the path

Detect format from `SpeechSynthesisResult.mimeType` (uniform across a run). `audio/mpeg` → §4.1; `audio/wav` → §4.2. Selection mode (N=1) skips concat entirely — same code, single buffer.

### 4.4 Where this lives

A small pure helper, e.g. `concatAudioBuffers(buffers: ArrayBuffer[], mimeType: string): ArrayBuffer` — no Obsidian/platform deps, unit-testable in isolation, importable by the read-aloud save path. **Not** in the Composer app; **not** dependent on it. (Composer keeps its own decode/re-encode concat for its own use cases; this is a separate lightweight concern.)

### 4.5 No large-note platform gate

Because the join is buffer-level (no real-time encode, no `OfflineAudioContext`), there is **no chunk-count or platform ceiling** the way the Composer path had. A large note costs N synthesis API calls (the same cost as playing it aloud today) + a cheap buffer concat. Mobile and desktop run the identical path.

---

## 5. Integration Points & Rough Component Changes

| Component | Change | Notes |
|-----------|--------|-------|
| `ReadAloudService` (`ReadAloudService.ts`) | Add an **opt-in persistence hook**: today `read()` discards buffers. Add an option (e.g. `read({ markdown, sourceName, capture?: 'none' \| 'buffers' })`) or a callback that yields each `SpeechSynthesisResult` as it's synthesized, so the caller can save without re-synthesizing. | Keep playback default unchanged. Don't double-synthesize. |
| New save service / reuse | Reuse `AudioGenerationService.writeAudio`-style temp-swap write, OR extract a shared `writeMediaFile` helper. (Note: review Task #3 already flagged `writeAudio`≈`writeVideo` duplication — this feature is a good moment to extract a shared vault-write helper.) | `vault.createBinary` + `ensureParentDirectory`. |
| Settings | New setting(s): enable save (bool), audio subfolder under `rootPath` (default e.g. `audio`), embed-on-save (bool), naming scheme. Pin to `settings.settings.storage.rootPath`. | See Q1/Q3. |
| `ReadAloudCommandManager` | Thread the `editor`/`file` + cursor through to the save+embed step; add menu items or honor the setting. | Editor already in scope at `:96`. |
| Embed insertion | Selection → `editor.replaceRange` at selection end (in-plugin), or `InsertTool` positional. Whole-note → prepend (`InsertTool` `startLine=1` / `vault.process`). Embed string `![[<basename>]]` per `OutputNoteBuilder` pattern. | `![[...]]` resolves by basename/shortest path — ensure unique filenames (§Q2). |
| Concat | New pure `concatAudioBuffers(buffers, mimeType)` helper — mp3 byte-join (+ID3/Xing strip on chunks 2…N) / wav header-merge. NOT Composer. | No `AudioContext`; mobile-safe; no platform/size gate. |

---

## 6. Rough PR-Slice Plan

One mechanism (capture buffers → format-aware join → save → embed); selection is the N=1 case. Two slices only because the insert location + trigger surface differ.

**Slice 1 — "Save selection as audio" (thin start, the N=1 path).**
- `concatAudioBuffers` helper (mp3 byte-join + ID3/Xing strip; wav header-merge) — pure, unit-tested. Handles N=1 trivially.
- Capture hook on `ReadAloudService` so synthesis buffers aren't discarded (never double-synthesize).
- Settings: audio subfolder under `<rootPath>` (default `audio` → `Nexus/audio/`) + naming scheme (Q2).
- Save via temp-swap write helper; embed `![[...]]` after the selected block / at cursor (editor in scope).
- **UI:** explicit "Save selection as audio" — command palette + **editor context menu on a selection** (desktop right-click / mobile long-press). Highlight → context menu → converts.
- Acceptance: highlight text → context menu "Save selection as audio" → mp3 lands in `Nexus/audio/`, `![[...]]` inserted at selection end, plays inline. Works on mobile.

**Slice 2 — "Save note as audio" (N>1, same join path).**
- Synthesize all chunks, `concatAudioBuffers` → ONE file, embed one `![[...]]` at top of note.
- **UI:** "Save note as audio" — command palette + file "⋯" menu.
- No platform/size gate (buffer join is cheap; cost = N synth calls, same as reading aloud today). Optional progress UI for long notes.
- Acceptance: "Save note as audio" on a large note → single seamless mp3 at top, one tap to play through. Identical on mobile + desktop.

**Slice 3 (optional) — Polish.**
- Overwrite/dedup UX, naming refinements, progress UI, optional Google-PCM→mp3 encode to shrink WAV output.

---

## 7. Design Questions

### RESOLVED (user, 2026-06-08)
- **Q1 — Save trigger:** ✅ Explicit "Save as audio" action (command + menu), separate from plain play. NOT an auto-save-on-play toggle.
- **Q4 — Concat reuse vs refactor:** ✅ Neither — do not use Composer at all. New pure `concatAudioBuffers` helper, raw buffer join (§4).
- **Q5 — Large whole-note policy:** ✅ Single file always; no size/platform gate. Buffer join has no real-time-encode cost.
- **Q6 — Output format:** ✅ Preserve provider-native mp3 via raw frame concat (small). WAV only for Google; single seamless file either way. Playlist rejected.
- **Q7 — Mobile:** ✅ Mobile is first-class for BOTH modes. The buffer-join path is platform-agnostic.
- **UI for selection:** ✅ Editor context menu on a highlight (desktop right-click / mobile long-press) → "Save selection as audio" → converts. Plus command palette.

### RESOLVED (user, 2026-06-08, cont.)
- **Q2 — File naming & dedup:** ✅ **Timestamped, always new** (no overwrite — every render is kept; the freshly-inserted `![[...]]` points at the new file).
  - **Whole-note:** `<note-basename> - <timestamp>.mp3`
  - **Selection:** `<note-basename> - <first few words of selection> - <timestamp>.mp3` (human-identifiable which selection it was)
  - Implementation notes: sanitize the snippet + basename for filename-illegal chars (`normalizePath` does NOT strip these), cap snippet length (~first 3–5 words / ~40 chars), pick a sortable timestamp format (e.g. `YYYYMMDD-HHmmss`). Accepted tradeoff: audio files accumulate in the folder (user is fine with this).
- **Q3 — Folder layout:** ✅ **Flat `<rootPath>/audio/`** (default `Nexus/audio/`). Subfolder name (`audio`) configurable in settings. No source-folder mirroring.

### STILL OPEN
- _None. Spec is complete and buildable._

---

## 8. Risks Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| `ReadAloudService` currently discards buffers — naive impl could double-synthesize (2× cost/latency) | Medium | Add a capture hook in the existing synth loop; never re-synthesize for save |
| `![[...]]` embed resolves by basename — name collisions break the embed (wrong file plays) | Medium | Unique/predictable naming scheme (Q2) |
| mp3 raw concat: ~26ms bit-reservoir artifact at chunk boundaries | Low | Inaudible for speech; accepted vs the desktop-only decode/re-encode alternative |
| ID3v2 / Xing header mid-stream if not stripped from chunks 2…N | Low | Strip leading metadata/VBR header on non-first mp3 chunks |
| Google WAV output is large (uncompressed PCM) | Low | Single provider only; recommend mp3 providers; optional future PCM→mp3 encode |
| Mode parity confusion (selection vs whole-note insert location) | Low | Selection→after-block/cursor; whole-note→top of note |
