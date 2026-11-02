# Maintaining screenshots and short demos

`catalog.json` is the source of truth for media identity, provenance, capture
version, refresh instructions and source-file dependencies. [INDEX.md](INDEX.md)
is generated: it lists every registered asset and its discovered repository
placements, plus unregistered media references. The [visual guide](../guide/visual-tour.md)
is the reader-facing gallery.

## Find an asset or every place it appears

```bash
python3 scripts/media.py index
python3 scripts/media.py check
```

The helper's behavior checks run with
`python3 -m unittest discover -s scripts -p test_media.py -v`.

The scanner covers README, guide, docs, src, .github, skill and this workflow, including
tracked files and new unignored files. It detects Markdown image embeds,
literal media links, and HTML image/video sources and posters. It does not
claim to resolve dynamically assembled URLs, CSS variables, live course
placements or remote website content. Review those manually when affected.
The index contains file/line locations; regenerate it after moving a placement.

Statuses have distinct meanings:

- **published**: a real asset available for product documentation.
- **source-only**: reusable material identified, with review still needed before publication here.
- **planned**: a coverage gap, not a completed capture or successful feature test.
- **retired**: history retained; no longer intended for active documentation.

Badges, example image paths and design mockup references appear in the discovery
section. Product screenshots and demos belong in the catalog. Add an asset once;
all uses of its stable path are found automatically. Register GIF and MP4
variants separately, with the same source and workflow identity in their descriptions.

## Review a release

```bash
python3 scripts/media.py review --base 5.21.1 --head HEAD
```

Use the actual previous release tag, not necessarily the example above. This
compares **committed trees**; commit intended UI changes before the final review.
It lists published assets whose watched source files changed, all their current
placements, and the recapture recipe. Exit 1 means review is still pending;
exit 2 means an input/tooling error. Planned and source-only assets remain a
separate production backlog and do not masquerade as release blockers.

Inspect each flagged asset against the candidate app. Keep it if the controls,
labels and result remain accurate; replace it if the demonstrated flow changed.
Check shared CSS/theme/layout changes visually, including adjacent frames in a GIF.
Dependency globs suggest impact; they do not prove visual correctness. New
features and renamed files also require a manual coverage pass: update catalog
watch paths and add missing shots even when no existing asset was flagged.

After inspecting an unchanged screenshot:

```bash
python3 scripts/media.py approve task-board --decision keep --note "Checked in candidate app; board labels and demonstrated action are unchanged"
```

Approval records a fingerprint of committed watched files. A later change to
those files invalidates the approval. A version bump or unrelated source change
does not force a new screenshot. The note is evidence supplied by the reviewer;
the command does not perform a visual review for them.

## Capture safely and honestly

1. Use a fresh sanitized practice vault/profile, never a working business or
   personal vault or the master course Seed Vault. Confirm vault identity in-band
   before mutations. Follow the Nexus testing skill's live-app protocol for
   application targeting and bundle verification.
2. Choose the released build or explicitly label a development preview. Record
   plugin version, Obsidian version, platform, date and viewport. Keep provider
   credentials private; do not put them in scripts, manifests, raw recordings or logs.
3. Use fictional meeting notes and a small project consistently across shots.
   Capture the visible action and actual result. Check generated notes and stored
   task relationships; do not substitute synthetic provider events for a real demo.
   Convert stored deadline timestamps independently and compare the complete
   calendar date, including year, with the source. A model's confirmation is not
   proof: the October 30 pilot needed year/day corrections before readback passed.
4. Keep raw masters outside the Git working tree. Review every frame for keys,
   account identity, notifications, real notes and clipboard contents before export.
5. Prefer readable PNGs and one-outcome GIF loops around 5–15 seconds. Retain MP4
   masters for longer walkthroughs. Preserve normal readable pacing; label cuts or
   accelerated waiting. Use captions outside the application image and meaningful
   alt text. Keep recordings from older versions explicitly labeled.
   For Nexus demos, keep chat in the sidebar with notes and the task board in the
   main workspace, following the user's approved layout. Establish that context,
   starting with the source note open so viewers see what the agent will use.
   Use a smooth focus zoom for typing and sending, then pull back immediately
   after send to show the whole workspace during the reply. Keep the saved note
   and task-board opening at that full-workspace scale, with chat still visible.
   For a multi-step showcase, continue through chat: ask Nexus to open the saved
   note, open the project board and update a fictional task. Show the actual
   screen changes and card moving to its new status. Use a functioning chat link
   or an explicit open request; do not substitute an unrelated navigation flow.
   Cut long tool waits and typing pauses with clear timing disclosure. Spend
   screen time on requests, transitions and verified results rather than long
   unchanged holds. Verify exactly the intended task changes after the run.
   A task form or
   finished note alone does not demonstrate the AI interaction. Show a visible
   mouse and restrained click feedback tied to actual input coordinates; camera
   motion must clarify the action without inventing UI or results. Review the
   rendered storyboard and exported clip against that shot list.
   Text needs its own motion review: use short labels with a restrained fade and
   small baseline movement after the camera settles, then clear them before the
   next action. Avoid abruptly swapping large headlines or animating every word.
   Play the actual prompt entry and streamed reply instead of jumping between
   finished chat screenshots. Hold the completed answer long enough to read;
   disclose shortened waits and altered playback speed. Record at 24–30 fps for
   new motion captures; a low-frame-rate screencast is limited source material,
   even when exported at 30 fps. Never fabricate a transcript to disguise it.
6. Aim for small exports: roughly under 500 KB per screenshot and 5 MB per GIF
   where readability permits. These are targets, not reasons to make text illegible.
   Link longer videos rather than loading them throughout the README.

Course screenshots reused here were captured October 19, 2026 from released
Nexus 5.21.1 in Obsidian 1.14.4 on Linux. Providers were unconfigured. They prove
the depicted UI, not an authenticated model response. Historical native-chat
frames and recordings have separate source-only entries. The approved Native
Chat V1 is named 7.4 although the current lesson is 7.6; the V2 export is a
mislabeled overview. Do not choose a recording by lesson number alone.

## Swap an asset without hunting down links

Export to a temporary file, inspect it, then replace the cataloged asset at its
stable path:

```bash
python3 scripts/media.py replace task-board --file /tmp/task-board.png --plugin-version 5.21.1 --platform "Obsidian 1.14.4 / Linux"
python3 scripts/media.py check
python3 scripts/media.py approve task-board --decision replaced --note "Recaptured candidate task board; verified note link and status update"
python3 scripts/media.py review --base 5.21.1 --head HEAD
```

Supply the actual captured versions. `replace` validates format signatures,
rejects LFS pointers, updates bytes/SHA256/dimensions and capture metadata, clears
old approval, and regenerates every placement in the index. It preserves the
original source attribution; when the origin changes, update the catalog's source
fields as part of the same change. Keep the same file format for a stable-path
swap. For a new format, add a new variant and update its placements explicitly.

Review PNGs/GIFs at their displayed README/guide size and full size. Verify GIF
looping, MP4 playback, captions and links. `check` validates signatures and bytes;
it does not decode every frame, certify playback or check remote HTTP availability.
Check public source/course links when changing them. Never publish private Drive
recordings as a side effect of updating the local index.

## Where things live

| Material | Canonical location | Maintenance |
|---|---|---|
| Product-facing screenshots and short loops | `media/screenshots/`, future `media/demos/` | Stable paths, separate catalog entry per variant |
| Asset metadata and coverage backlog | `media/catalog.json` | Edit when provenance, coverage or dependencies change |
| Actual repository placements | `media/INDEX.md` | Generate; never maintain duplicate placement arrays |
| Public product gallery | `guide/visual-tour.md` | Select useful assets and clear captions |
| Course source screenshots and evidence | Your AI Second Brain course in the Synaptic Labs vault | Read through Nexus; preserve course-owner sources |
| Course recordings and subtitles | Drive sources referenced by course storyboards | Validate actual bytes, rights, privacy and version before extraction |
| Raw captures, app profiles and credentials | Private task artifacts outside this repo | Keep out of Git and public catalog |
| Release review instructions | `.skills/nexus-release/` | Edit source, then sync skill mirrors |

The course is promoted via its public [Your AI Second Brain page](https://www.synapticlabs.ai/learn/your-ai-second-brain).
Keep the CTA link consistent in README and the visual guide. Product docs remain
usable on their own; do not move required setup instructions behind the course.
