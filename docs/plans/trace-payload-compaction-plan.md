# Implementation Plan: Bounded Activity Traces

> Analysis date: 2026-10-20
> Source baseline: `c4d19988` (Nexus 5.21.1 + #422–#424)
> Status: Part 1 and 3.1 implemented and verified locally (uncommitted, branch `plan/trace-payload-compaction`); see "Implementation status". Part 2, 3.2–3.5 and the shard-size change await decisions.
> Skills applied: `nexus-storage` (invariants, replay, rebuild cost), `nexus-mobile-compat` (memory, imports, path confinement), `nexus-testing` (lanes, mock honesty, live loop).

## Outcome

Every activity trace is small by construction, whatever the caller sends: an agent through the CLI, an MCP client, the chat view or a migration. When a trace is recorded, Nexus measures each value. Anything large is replaced by a short descriptor (size, hash, preview). There is no opt-in and no change to how tools are called.

Existing oversized traces are compacted once, automatically, on every user's vault. Payloads that may exist nowhere else are archived first. The migration is safe:
- with every sync method Nexus supports;
- when devices run different plugin versions;
- on phones;
- without a cache rebuild, which would re-embed the vault at full API cost.

A trace keeps what it is for: **who did what, to which file, when, why, and whether it worked**. It is an activity log, not a second copy of the vault.

## Root cause

- **The whole request is one string.** Under the CLI-first contract, `useTools` receives one `tool` command string. CLI transport flags splice payloads into it: `--content-stdin` → `--content <stdin>`, and `--<flag>-file f` → `--<flag> <contents of f>` (`cli/commandLine.ts:340-391`). MCP clients send the same thing directly, so this isn't a CLI-only problem.
- **The trace keeps the request word for word.** `ToolCallTraceService.sanitizeParams()` (`src/services/trace/ToolCallTraceService.ts:399`) only removes `context`, `workspaceContext` and `_displaySessionId`. Every write, replace, insert and create-state stores a full copy of its payload. It also stores `memory`/`goal`/`constraints` a second time, though `buildContextMetadata()` already put them under `context`.
- **Old data stored results too.** Pre-5.x traces kept whole results under `legacy.result`/`response.result`, including `loadWorkspace` dumps that embedded earlier dumps. `WorkspaceMigrator` (`src/database/migration/WorkspaceMigrator.ts:155-166`) still imports them unchanged for anyone upgrading today. It writes events directly and bypasses `TraceRepository`.
- **The shard cap is soft.** `ShardedJsonlStreamStore.appendEventToLockedStream()` only rotates when the current shard is non-empty and would overflow (`:342-345`). A single record larger than `maxShardBytes` (default 4 MiB) gets a shard to itself, at full size.

The trigger on this machine was one QA session (2026-10-19). It wrote 71 JSON evidence dumps of ~3.6 MB each, one of them 13 times. It was only the trigger: every write already copies its body.

## Who else is affected

Any production user who has any of the following:

| Condition | Consequence |
|---|---|
| Writes large notes through MCP or the CLI | Workspace streams grow by the note's size on every write, and the SQLite cache grows with them. |
| Upgraded from pre-5.x | Legacy traces carry full results; nested dumps are tens of MB. |
| Obsidian Sync **Standard** plan (5 MB per-file limit) | A shard over 5 MB **never syncs**. Its events silently never reach other devices. Compaction makes those shards syncable again and repairs the divergence. |
| iCloud / Syncthing / Dropbox / Git sync | Large files sync slowly and are more likely to produce conflict copies (#290). |
| Mobile | Reading a tens-of-MB shard during replay is a memory risk. |
| Large vaults | `memory_traces.metadataJson` inflates the SQLite blob. Every save copies about 3× that size (`nexus-storage` failure mode "RangeError: Array buffer allocation failed"). |
| Any sync method | Sync uploads the whole active shard on every append. A bigger shard costs more on every change. |

## Measurements (this machine, 2026-10-20)

| Vault | Nexus data | `trace_added` | Largest record | Shards to rewrite (records > 64 KiB) |
|---|---|---|---|---|
| Synaptic Labs | 453 MB | 410 MB (35.5k traces) | 59.2 MB | 82 / 236 |
| Professor Synapse | 52 MB | 38 MB | 3.3 MB | 12 / 152 |
| Rose N Thorn | 58 MB | 46 MB | 0.9 MB | 11 / 35 |

Synaptic Labs breakdown: 196 MB in 343 `content write` traces with the body in `input.arguments.tool`; 107 MB in 3 legacy result dumps; 18 MB in ordinary write bodies; 8 MB of duplicated context fields.

How recoverable the removed payloads are. For the 236 unique large payloads, the CLI quoting was undone and the result compared with the vault:

| Payload | Count | Recoverable elsewhere? |
|---|---|---|
| Identical to the current file | 112 | Yes: the note itself |
| File changed since | 95 | Only in Sync version history or Git, if the user has them |
| File no longer exists | 9 | Same |
| Same bytes written again | 11 | Yes: the earlier trace |
| `memory create-state` payloads, other legacy dumps | 8 + 3 | No |

**So some removed payloads are the only copy for some users. The migration must archive and never simply drop.** Gzip shrinks what is removed from about 250 MB to about 34 MB.

Projected Synaptic Labs size after compaction: **453 MB → ~110 MB**. A per-value limit alone reaches only 166 MB, because legacy result trees are many small strings; that's why the record budget below is needed.

## What a trace keeps

| Field | Kept | Notes |
|---|---|---|
| `tool` (`id`, `agent`, `mode`) | yes | |
| `context` (`memory`, `goal`, `constraints`, `sessionName`, ids) | yes | Only copy; removed from `input.arguments` |
| `input.arguments.tool` | yes, compacted | Verb and short flags verbatim; large tokens replaced in place |
| other `input.arguments` | yes, compacted | Per-value rule |
| `input.files`, `batch.results`, `activeSkills` | yes | Already small |
| `outcome` | yes, compacted | Error strings follow the per-value rule |
| `legacy.result`, `response.result`, `result` | descriptor only | Results were never meant to be kept |
| `omitted[]` | new | One descriptor per removed value |

```ts
interface OmittedValue {
  path: string;      // "input.arguments.tool#0:--content", "legacy.result"
  bytes: number;     // UTF-8 length of the original value
  sha256: string;    // hex digest of the original UTF-8 bytes ("fnv1a:<hex>" if SubtleCrypto is absent)
  preview: string;   // first 200 code points, whitespace collapsed
  archived?: string; // archive entry id, set only by the migration
}
```

In the command string, the removed token becomes one quoted marker, so the string still parses:
`content write --path "QA/foo.json" --content "<omitted 3.6 MB sha256:1a2b3c4d>"`.

The output is a **pure, deterministic function of the input**: no clock, no device id, no randomness. Two devices compacting the same event produce identical bytes. The multi-device safety below depends on this.

## Part 1 — write path: compaction at every way a trace gets in

### 1.1 `src/services/trace/TraceMetadataCompactor.ts` (new, pure)

- `compactTraceMetadata(metadata): Promise<{ metadata; omitted; originalBytes; changed }>`.
- **Fast path:** serialized metadata ≤ `MAX_TRACE_VALUE_BYTES` comes back unchanged without being walked.
- **Command-aware pass.** For `input.arguments.tool` over the limit:
  - `splitTopLevelSegments()`, then `tokenizeWithSpans()` (1.4) per segment;
  - splice a quoted marker over each oversized token's raw span;
  - nothing else is re-quoted, so the rest of the command stays byte-identical.
- **Generic pass:** any other string over the limit becomes a descriptor object.
- **Result subtrees** (`legacy.result`, `response.result`, `result`) over the limit become one descriptor.
- **Record budget.**
  1. If the serialized output still exceeds `MAX_TRACE_METADATA_BYTES`, replace the largest remaining subtree, and repeat until it fits. The order is deterministic: largest first, ties broken by path.
  2. As a last resort, keep only the envelope: `tool`, `context`, `outcome.success`, `input.files`, `omitted`, `originalBytes`.
- Constants, not settings: `MAX_TRACE_VALUE_BYTES = 2 KiB`, `MAX_TRACE_METADATA_BYTES = 16 KiB`. Ordinary traces are 1–3 KB.
- Mobile: no Node imports. `crypto.subtle.digest` as in `CacheManager`, falling back to `fnv1aHex` (`services/skills/skillHash`).

### 1.2 Entry points

| Entry | Change |
|---|---|
| `TraceRepository.addTrace()` (`:173`) | Compact once and serialize once; the same string goes to JSONL and SQLite. Covers `ToolCallTraceService`, `ChatTraceService`, `WorkspaceStateService` and `MemoryService`. |
| `WorkspaceEventApplier.applyTraceAdded()` (`:409`) | Compact before the `INSERT OR REPLACE`. Replay and sync from older-version devices then never bring a bloated row into SQLite, even while the JSONL stays large. SQLite is a deterministic projection of JSONL, so the invariant holds. It must **not** write JSONL. |
| `WorkspaceMigrator` legacy import (`:155-166`) | Compact `traceData.metadata` before building the event. Users upgrading from pre-5.x get bounded traces from the start. |

Layering: the repository and the applier import a pure function from `services/trace`. If that direction isn't wanted, move the module to `src/database/traceCompaction.ts`. The behavior is the same.

### 1.3 `ToolCallTraceService.sanitizeParams()`

Also remove `memory`, `goal`, `constraints`, `sessionName`, `workspaceId` and `sessionId` after `buildContextMetadata()` has captured them. `WorkspaceContextBuilder.extractTraceContext()` already reads `context.*` first.

### 1.4 `ToolCliNormalizer.tokenizeWithSpans()`

Thread start/end offsets of each token's raw text through the existing `tokenizeWithMeta()` loop, without a second parser, so the two cannot drift.

### 1.5 Shard store visibility

When `recordBytes > maxShardBytes`, still write the record, and log one structured warning (category, event `type`, bytes, path). Refusing would lose user data: `state_saved` and conversation messages are real data, and bounding them is a separate decision (open question 2). After 1.2, traces can no longer reach the cap.

## Part 2 — migration: compact existing data on every user's vault

A versioned maintenance step, `TraceCompactionMigration` in `src/database/migration/`. It reuses `LegacyArchiver`'s conventions. It runs in the background after `waitForQueryReady()` resolves true, on every device.

### 2.1 What the migration must never do

- **Trigger a cache rebuild.** A rebuild re-embeds the vault (`nexus-storage`: "Rebuildable does not mean cheap"). SQLite rows are updated in place.
- **Change event identity.** Ids, order, `timestamp`, `deviceId`, `type`, `workspaceId`, `sessionId` and `content` stay as they are. Only `data.metadataJson` changes.
- **Touch a shard another device might still append to** (2.3).
- **Rename, merge, renumber or delete shards.** Cursors are keyed by full filename (`paths-and-layout.md`), and older versions only read canonical names.
- **Drop a payload that may be the only copy** (2.4).
- **Touch conversations, tasks, or non-trace events.** Those are only measured and reported.

### 2.2 Candidate selection, cheap enough for every startup

- Walk `workspaces/*/` canonical shards (`SHARD_FILE_PATTERN`) plus conflict siblings (`SHARD_CONFLICT_PATTERN`). A sibling is never a writer target, so it counts as sealed once 2.3 holds for its base.
- Keep a per-device progress record of `(shardPath → size, mtime, result)` in plugin-scoped storage (`resolvePluginStorageRoot().migrationRoot`), which isn't synced (#127). Unchanged shards are skipped without being read, so after the first pass a startup costs one `stat` per shard.
- A shard is a candidate if it holds a `trace_added` line over **64 KiB**. That is the migration threshold, deliberately higher than the 2 KiB write threshold:
  - 64 KiB catches nearly all of the bloat (Synaptic Labs: 306 of the 312 MB in large records).
  - It rewrites a third of the shards instead of all of them, which spares every user a full re-upload of their event store.
  - Small historical traces can keep their few KB.
- Yield between shards and stop on unload (`nexus-storage`: "A long walk mid-flight"). Resume from the progress record.

### 2.3 When a shard is safe to rewrite (multi-device, any sync method, mixed versions)

Every version appends only to the last canonical shard it can see, and that index never decreases on a device. So:

> A shard `S` in stream `X` is **settled** when, for every `deviceId` that has written an event to `S`, the same stream holds an event from that device in a shard with a higher index. In addition, `S` must be unmodified for at least 7 days.

Decided 2026-10-20: protect wherever possible. That means the 7-day quiet period **and** the lost-append check in 2.6.

- The first condition proves that every known writer has moved past `S` for good. It covers the Standard-plan case: a device that never received oversized shard `N` keeps appending to `N-1`, so `N-1` is not settled while that continues.
- The quiet period covers a device that has never written to this stream but might start on a stale view.
- For single-device users the first condition is always met.
- The residual risk is a device that wrote to the stream, then sat offline for more than 7 days while another device moved on, then appends. Under last-writer-wins sync, that append could lose against the rewrite. 2.6 checks for exactly that.

Anything not settled is left for a later startup, never forced.

### 2.4 Archive before rewrite

- **What gets archived.** For each removed value, compute its hash. Then:
  - If it's a `content write` payload whose bytes equal the current vault file at `--path`, record "redundant" and don't archive.
  - Otherwise, store it once in a content-addressed entry: `archive/trace-payloads/<sha256>.json.gz`, holding `{ source shard, event id, path, bytes, sha256, value }`. The descriptor gets `archived: <sha256>`.
  - Also keep the original shard bytes as `archive/shards/<vault-relative shard path>.gz`. Restoring is then "decompress over" without re-splicing anything.
- **Location.** `resolvePluginStorageRoot(app, plugin).dataRoot + '/archive/trace-compaction-v1/'`, never a literal (`nexus-storage` invariant 3). Obsidian Sync doesn't sync it (#127), so it stays local to the device that did the rewrite. Users who sync the whole folder (iCloud, Syncthing, Dropbox) will see it replicated. Files are kept under 4 MiB by splitting into `.partNNN` chunks, so they never hit the Standard plan's limit for users who do sync it.
- **Compression:** `CompressionStream('gzip')`, a web API, so no dependency and fine on mobile. If it is missing, write the bytes uncompressed with a `.json` suffix.
- **Paths:** archive paths derive from event-store keys, so they're trusted. Build them with `vaultPathFromTrusted`, write through the storage layer's existing allowlisted adapter path, and check with `npm run lint` (`nexus-mobile-compat` confine-a-vault-path).
- **Verification before any rewrite:** read each archive entry back and check the hash. If that fails, skip the shard.

### 2.5 Rewrite

1. Parse the shard (lines over 64 KiB through the compactor; all others byte-for-byte as they were).
2. Re-serialize. Only the compacted lines change; others keep their exact original text.
3. Write to `shard-NNNNNN.jsonl.compacting`. Re-read it and verify the same event-id sequence, then replace the shard with an adapter write of the verified bytes. Delete the temp file.
4. `UPDATE memory_traces SET metadataJson = ? WHERE id = ?` for the rewritten ids, in one transaction. Then `getQueryCache().clear()` (`failure-modes.md`).
5. Record the shard in the progress record.

Then, on each device, a **row-level pass** compacts any `memory_traces` row whose `length(metadataJson)` exceeds the limit, from SQLite alone. This catches devices that receive an already-compacted shard through Sync: their cursor still matches, so they would never re-read it. `VACUUM` runs only if `freelistCount` shows it would shrink the blob, and only once.

Mobile (`nexus-mobile-compat`): no shard over 16 MiB is rewritten on a phone. Those wait for a desktop device and are listed in the report. A mobile-only user keeps them, but the write path stops new ones, and the row-level pass still shrinks the cache.

### 2.6 How other devices see it

- **Same version or newer than 5.8.10.** `ReconcilePipeline` sees that the cursor's `lastEventId` is still present (ids are preserved). If the file changed, the silent-overwrite path rescans, and `applied_events` deduplicates. Trace rows are `INSERT OR REPLACE`, and `applyTraceAdded` compacts them (1.2), so the cache ends up identical.
- **Versions before 5.8.10** use a mod-time scan and re-read the file. Re-applying a shard in order is how they always behave. Needs a replay test (Tests).
- **Two devices compacting the same shard** produce identical bytes, so there is no content conflict. If a sync tool still writes a conflict sibling, it holds the same event ids and replay deduplicates it.
- **Lost-append check (2.3's residual risk), included.** Each device keeps a small local journal, in unsynced plugin storage capped at 14 days and 8 MiB, of the events *it* appended. The journal holds the raw serialized line for each, so repair never has to rebuild an event from SQLite. When reconciliation finds a cursor whose `lastEventId` is gone (the existing silent-overwrite path), the device checks its journal against the replaced shard. Any of its own events that are missing get re-appended, unchanged, to its active shard. Event ids are preserved, so `applied_events` dedup keeps the repair idempotent on every device. This protects against *any* last-writer-wins overwrite of a shard, not only this migration's.

### 2.7 Report and UI

`<dataPath>/_meta/trace-compaction-<deviceId>.json`, synced so the owner can see the result from any device. It records:
- version, shards and bytes before and after;
- archive entry count and size;
- redundant payloads skipped;
- shards deferred and why (not settled / too big for mobile);
- counts of oversized non-trace records by type.

When a run finishes, show one notice: "Nexus compacted activity history: 453 MB → 110 MB. Originals archived on this device." A Data settings section shows the report, plus **Restore originals** and **Clear archive**. Clearing is UI-only permanent deletion, consistent with "the AI never gets a destructive delete".

## Part 3 — chats: stop re-saving the whole message

### What the code does

- `MessageRepository.update()` (`src/database/repositories/MessageRepository.ts:453`) had a dirty check (`hasChanges()`, `:574`). But when *any* field changed, it wrote every supplied field, including the full `tool_calls` array with every result. It also compared tool calls as raw JSON, while the cache holds a different shape after a replay, so callers that pass the full message (`ConversationService.updateConversation`) re-saved every result again after any rebuild. (The main chat itself only writes at turn start and end; see 3.2.)
- Replay already merges field by field. `ConversationEventApplier.applyMessageUpdated()` (`:177`) only updates columns whose field is present. **A `message_updated` that omits unchanged fields gives the same result on every reader version.**
- Stored tool results are real chat data. `ConversationContextBuilder` replays them to the model on later turns, and the UI rebuilds tool bubbles from them. Unlike traces, they must not be replaced by descriptors without deciding what the model should see.

Measured (Professor Synapse + Synaptic Labs chats): 5.5 MB of message events hold ~0.9 MB of unique content. Unchanged `tool_calls` re-sent: 2.3 MB. Arrays re-sent because one call was added: most of the remaining 2.4 MB. One message was saved 58 times (1.43 MB) for ~100 KB of final content. Unique tool results: p50 2.4 KB, p95 48 KB, max 72 KB.

### 3.1 Write only what changed (Release A)

- Replace `hasChanges()` with `changedFields()`, which returns the set of fields that differ after normalizing to the stored shape. Today, a reshaped but equal `toolCalls` array counts as a change.
- The event carries only those fields; SQLite updates the same fields.
- Same change for `branch_message_updated` (`BranchRepository`/`BranchManager`, applier `:53`) after confirming its applier also merges field by field.
- No format change and no new event type, so it is safe for older versions. Expected cut: about 40–50% of chat bytes on these vaults; more in long agentic turns.

### 3.2 Mid-turn checkpoints (corrected premise; approved and implemented)

Approved on 2026-10-20 as "coalesce mid-turn writes to one per 2 s". Mapping the code afterwards showed the premise was wrong:

- The main chat writes the assistant message **once at turn start** (an empty `draft`, `StreamingResponseService.ts:191`) and **once at the end** (`persistTerminalMessage`, `:446-489`). Mid-turn, the only writes are cost/usage metadata (`CostTrackingService.updateMessageCost`, about 3 per round on Anthropic), which 3.1 now writes as metadata-only events. Turn state lives in memory (`ChatTurnStore`).
- #122 added a dirty check, not a save cadence; there is nothing to "reuse".
- A crash mid-turn therefore loses the **whole** turn: the stored row stays an empty `draft`. Nothing marks it interrupted on reload.
- The 58-save message measured in Professor Synapse came from repeated whole-message writes, where the dirty check misread replayed tool-call shapes as changes (`ConversationService.updateConversation` loops). 3.1's shape-normalised comparison removes those.

So coalescing has nothing to coalesce. The real choice is whether to **add** mid-turn checkpoints, at most one every 2 s, so a crash keeps the partial turn, marked interrupted on reload. With 3.1 and 3.5 such checkpoints are cheap (changed text fields plus one upsert per tool call). The cost is more appends to the active conversation shard during a turn, and therefore more Sync uploads.

Decided 2026-10-20: add the checkpoints ("Sync is fine"). Implemented as `TurnCheckpointer` (`src/services/chat/TurnCheckpoint.ts`), wired into `StreamingResponseService.generateResponse`:
- The first change is saved at once; later changes are folded into at most one save per 2 s, one at a time.
- Only content, reasoning and tool events trigger a save; usage and cost events do not.
- `close()` runs before the final save, cancelling anything pending and waiting for a save in flight, so the final save always lands last.
- A checkpoint is stored as `streaming` with a `metadata.turnCheckpoint {at, deviceId}` marker; the final save replaces metadata, which drops the marker.
- `ChatService.getConversation` repairs a checkpointed message with no live local turn: at once if this device wrote it, or after 30 min if another device did. It is kept as `aborted`, with unfinished tool calls removed and `metadata.interruptedTurn` set. Messages without a marker (subagents, older versions) are left alone.
- Live in the test vault: a turn paused mid-stream was stored with its partial text and reasoning. A plugin reload mid-turn left that partial turn on disk, and loading the conversation showed and saved it as `aborted`, text intact.

Side finding, fixed: `ConversationService.updateConversation`'s fast path never compared `toolCalls` or `alternatives`, so a change to only those (e.g. `AbortHandler.ts:66` stripping incomplete calls) was silently not persisted. `getAllAdapterMessages` did not even fetch them. Both are now compared, tool calls in the persisted shape. The same conversion also dropped `name`/`parameters` from every tool call it saved; they are now kept.

### 3.5 Tool calls written once each (implemented; active for mid-turn writes)

3.1 stops unchanged fields from being re-sent. But `tool_calls` is a single field, so every new call still re-sends the whole array with every earlier result. In the live simulation (12 rounds, 20 KB results): old code wrote 4.4 MB, 3.1 writes 2.2 MB, and the unique content is ~0.25 MB.

Proposal:
- A new `message_tool_call_upserted` event carries **one** call, keyed by call id, each time it starts or finishes.
- At turn end (complete, abort or fail), one ordinary `message_updated` with the full `tool_calls` array.

Devices on older versions skip the unknown event type: the applier switch has no default. They then catch up at turn end from the final snapshot, so nothing is lost for them except mid-turn progress.

Expected cost per turn: each result once, plus one final snapshot, so about 2× the unique content instead of growing with the square of the rounds (~0.5 MB in the simulation).

Needs:
- an applier case that merges by call id;
- a replay test proving deltas followed by the snapshot equal the snapshot alone;
- a cache-rebuild check (`nexus-storage` persist-new-data step 7).

### 3.3 Very large single tool results (approved and implemented)

A chat that reads a 3 MB note stores a 3 MB tool result, and replays it to the model on every later turn. Proposal:
- Keep results up to 256 KiB unchanged.
- Above that, store head and tail (64 KiB each), plus a descriptor with size and hash, and a note that the middle was trimmed. The model sees the trimmed version on later turns, and the bubble says "trimmed, 3.1 MB".

This also protects context windows. Context compaction already summarizes old turns; this bounds a single turn. It is a behavior change for what the model remembers, so it needs your call (open question 2).

### 3.4 Existing chats (Release B, conservative)

Use the migration machinery from Part 2 on conversation streams: remove fields from historical `message_updated` events when they equal that message's previous value in replay order. Only when all of the following hold:
- the shard is settled (2.3);
- **only one device has ever written to that message**;
- the earlier value is in the same or an earlier settled shard.

The final state is identical by construction, and the test is "replay before and after gives identical `messages` rows". Nothing in chats is archived, because nothing is lost.

## Shard size (approved and implemented in Release A)

Plain version: Nexus records activity by adding lines to the end of a file, and starts a new file at 4 MB. Sync tools cannot send "just the new line". Every time the file changes, Sync uploads the whole file again and keeps that copy in version history. So each small change costs as much as the current file size.

Measured today: the active Synaptic Labs shard (3.3 MB) has **100 versions in Sync history from the last 2¼ hours, 146 MB stored**. The account went from 54.37 to 54.82 GB in that time.

| | 4 MiB (today) | 1 MiB |
|---|---|---|
| Average upload per change | ~2 MB | ~0.5 MB |
| Version-history growth | 1× | ~¼ |
| Files for 110 MB of data | ~28 | ~110 |
| Startup listing | negligible | still negligible: a few hundred `stat` calls |
| Records that get their own shard | > 4 MiB | > 1 MiB, rare after Parts 1 and 3 (largest state seen: 0.94 MB) |

It only affects new shards; existing ones are left alone. Existing installs have the old default saved explicitly in `data.json` (`storage.maxShardBytes: 4194304` here), so a one-time settings upgrade has to rewrite exactly `4194304` to the new default. Any other value is a user choice and stays. Recommendation: switch the default to 1 MiB in Release A. 3.2 multiplies the saving, because fewer writes also means fewer uploads.

## Implementation status (2026-10-20)

Done, with tests that fail against the old code (each checked by reverting or mutating the change):

| Item | Where | Verified |
|---|---|---|
| Compactor | `src/services/trace/TraceMetadataCompactor.ts` | 14 unit tests. The real tokenizer is the reference (spliced, bare-base64, multi-segment, trailing-backslash and JSON-incompatible escapes). Determinism. Hash equals the SHA-256 of the value the tool received. |
| Write path | `TraceRepository.addTrace` | Live: a real 3.6 MB QA file written with `--content-file` produced a **1,550-byte** trace (4.2 MB before). The recorded hash equals the note's `sha256sum`. |
| Replay path | `WorkspaceEventApplier.applyTraceAdded` | Live: real Synaptic Labs shards copied into the test vault (117 MB legacy, 13 MB from Oct 19) replayed into the cache as 3.4 MB / 1.8 MB, largest row 13.6 KB. JSONL byte-identical afterwards. Activity summary and memory search still describe the compacted writes. |
| Legacy import | `WorkspaceMigrator` | Unit test with a nested loadWorkspace result. |
| Duplicate context | `ToolCallTraceService.sanitizeParams` | Unit test; identical values only. |
| Oversize warning | `ShardedJsonlStreamStore` | Unit test. |
| 3.1 changed fields only | `MessageRepository.update` / `changedFields` | 4 harness tests (real repository + real applier replay). Live: the 12-round simulation wrote 2.2 MB instead of 4.4 MB, and every event carried only what changed. |
| Shard size 1 MiB | `DEFAULT_STORAGE_SETTINGS`, `resolveMaxShardBytes` | Saved `4194304` maps to 1 MiB; other values kept; relocation uses the effective value. Settings and resolver tests. |
| 3.5 per-call events | `message_tool_call_upserted`; `database/utils/toolCallEvents.ts`; applier case; `CompactionTranscriptRecoveryService` | 9 harness tests: one upsert per new call, full snapshot at turn end, a device skipping upserts still converges, crash mid-turn replayable, removal falls back to a snapshot, 12-round turn writes each result exactly twice. Mutations (no final snapshot / no applier case) fail. |
| Same-millisecond ordering | `MessageRepository.awaitDistinctTimestamp` | This device's writes to one message get strictly increasing timestamps, so replay order can't flip on a random event id. |
| 3.3 trim > 256 KiB | `utils/toolResultTrim.ts`; persisted tool calls (events and live cache); the 4 history builders | 6 unit tests plus 9 builder tests: history gets head and tail with a note in every provider format, while the current turn's continuation still gets the full result. Gemini always gets an object. Reverting the builders fails 5. |

Findings while building:
- `branch_message_updated` is declared but never written, and the applier ignores it. Branch messages go through `MessageRepository.update`, so 3.1 already covers them.
- The CLI tokenizer (`tokenizeWithMeta`, `splitTopLevelSegments`) takes ~1.8 s on a 4.9 MB command, character by character. The compactor avoids it with a single `indexOf`-driven scanner (~175 ms on 5.6 MB of escape-dense JSON). But the tool's **own execution** of such a write still pays the 1.8 s. Separate follow-up.
- Local `node_modules` had drifted from the lockfile (`obsidian` 1.14.4 vs 1.12.3), producing 7 lint errors that CI doesn't see. `npm ci` restored parity.

## Tests

Lanes follow `nexus-testing`. Every assertion must be able to fail: fixtures reproduce real shapes, not plausible ones.

| Lane | Test | Proves |
|---|---|---|
| unit | `TraceMetadataCompactor` | Compacted command keeps verb, `--path` and short flags through `splitTopLevelSegments` + tokenizer. Payloads with `"`, `\n`, emoji and `;` stay correct. Fast path returns the same object. Output stays under budget for a generated 59 MB-style nested legacy result. |
| unit | Determinism | Same input → identical bytes, run twice and in reversed key order (habit 2). |
| unit | `tokenizeWithSpans` | Spans splice back into the raw input; values match `tokenizeWithMeta` on the existing tokenizer corpus. |
| unit | `TraceRepository.addTrace` / `applyTraceAdded` | A 5 MB `content write` produces < 16 KiB in both JSONL and SQLite. A fat event replayed from an "old device" lands compacted in SQLite while the JSONL is unchanged. |
| unit | `WorkspaceMigrator` | Legacy traces with `result` import compacted. |
| unit | Shard store | An oversized non-trace record is written and warns. |
| headless (real filesystem) | Migration | Synthetic stream of three devices. Only settled shards are rewritten, the last shard never. Ids, order and untouched lines are byte-identical. Archive round-trips. A second run is a no-op. An interrupted run (killed after the temp file) resumes cleanly. |
| headless | Settledness | Device B never received shard N and keeps appending to N-1 → N-1 is never rewritten. |
| headless | Lost-append check | Rewrite wins over an offline device's append → that device re-appends its event exactly once. |
| headless | Mixed-version replay | Old-format reader (pre-5.8.10 mod-time path) and current `ReconcilePipeline` both replay a rewritten shard to the same row counts as before, apart from metadata size. |
| unit | `MessageRepository.changedFields` | Only changed fields reach the event. Reshaped-but-equal `toolCalls` count as unchanged. Explicit `null` still clears (`nexus-storage` persist-new-data step 5). |
| headless | Chat replay equivalence | Replaying a real exported long conversation (Professor Synapse `conv_4a5212af…`, copied into the test vault) before and after 3.1/3.4 gives identical `messages` rows. |
| unit | Write coalescing | Intermediate updates coalesce; the terminal state (complete/abort/fail) is always written immediately. |
| unit | Shard size upgrade | Exactly `4194304` → new default; custom values untouched. |
| live loop | In-app | (1) `content write --content-file` of 5 MB → trace line < 16 KiB. (2) Migration on a **copy** of each of the three real vaults' `Nexus/data`; the report matches the measurements above. (3) Reload, then **Nexus: Refresh synced data**; no errors in `dev:errors`, and the workspace activity summary still describes the writes. |
| live, multi-device | Real Sync | Run on this machine only. `sync:history` on a rewritten shard shows one upload; the desktop and Mac show no conflict copies, and their row counts are unchanged. |

Run `node scripts/check-mobile-imports.mjs .` and `npm run lint` (`nexus-mobile-compat`). Run both `nexus-testing` scripts before calling the tests done.

## Rollout

1. **Release A — write paths (Part 1, Part 3.1–3.3, shard size).** Stops growth for every user immediately. No format change: new traces and messages only, plus compaction on replay into SQLite.
2. **Dry run on this machine.** Run the migration in report-only mode against copies of all three vaults, and review the report.
3. **Release B — migration (Part 2)**, with a kill switch. Like other maintenance steps, it is skipped while a storage migration is pending or failed (`pluginStorage.migration.state`).
4. Changelog entry naming the space recovered and where the archive lives.

## Open questions

Decided 2026-10-20: (a) protect wherever possible, so a 7-day quiet period and the lost-append check both ship; (b) chats get their own part; (c) 1 MiB shard default; (d) 3.5 per-call events; (e) 3.3 trimming above 256 KiB; (f) 3.2 approved as coalescing, but see its corrected premise.

Also decided 2026-10-20: mid-turn checkpoints on; fix the `updateConversation` fast-path bug (done).

1. **`state_saved`.** Measure through the migration report before bounding (max 0.94 MB here).
2. **Archive lifetime.** Keep it indefinitely (proposed), or offer to clear it after N days?
3. **Agent guidance.** Should the `nexus` skill also say that multi-MB machine-generated JSON belongs in attachments rather than notes?
