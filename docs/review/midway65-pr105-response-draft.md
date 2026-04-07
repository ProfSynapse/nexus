# PR #105 — Response Draft

Hi @Midway65, thanks for the continued work here — you keep finding real things worth looking at.

## What we took

We pulled out the dead per-turn fetch removal and landed it on `fix/remove-dead-per-turn-fetches`. You were right that `vaultStructure`, `availableWorkspaces`, `availablePrompts`, and `toolAgents` were being fetched every message send and never consumed by the builder — I'd removed the consumption side a while back but never cleaned up the fetch side. That's now gone (-110 lines).

We also fixed the `workspace?.context` guard you identified — that was a real upstream bug dating back to Sep 2025 where most user-created workspaces were silently skipped during selection. Landed in #107.

## Why we can't merge this PR as-is

**1. It carries the full PR #97 payload.** This PR is 40 files / 66 commits / +2,250/-1,896 but the workspace feature only touches ~5 files across 8 commits. The rest is the PR #97 content we already went through — schema migrations v12-v19, the action bar feature, the JSONL orphan pruning, and ~1,500 lines of CRLF whitespace conversion. All of that is still bundled in here, which makes it impossible to review or merge cleanly.

**2. The two-tier system prompt doesn't match our architecture.** The system prompt gets rebuilt before each message send and is always sent at position zero of the completion. The full workspace blob goes in there so the LLM is oriented to the workspace on every turn — it needs the folder tree, sessions, and context to function properly.

The "slim header on turn 2+" approach (G-W2/G-W3) saves tokens, but the LLM loses the folder tree and workspace context after the first message. Telling it to "call `memoryManager.loadWorkspace` if you need details" adds a round-trip and defeats the purpose — the LLM should just *know* what workspace it's in without having to ask. We need the full blob every time.

This also means the "cheap restore" (G-W1) can't be separated out — on `main`, the `restoreWorkspace` call via `loadWorkspace()` is what populates `loadedWorkspaceData`, which is what the system prompt builder serializes. Replacing that with a basic DB lookup would remove the folder tree from the system prompt.

**3. Two of the 3 bug fixes address bugs introduced by the refactor, not bugs on `main`.** The G-W3 flag race condition only exists because the G-W3 flag was introduced in this PR. The redundant `context` parameter is only redundant after the `setWorkspaceContext` refactor. These are valid fixes within your branch, but they don't address issues in the upstream codebase.

The `workspace?.context` guard that blocked 14/21 workspaces was a good catch — that one *was* a real bug on `main` (dating back to Sep 2025). We've fixed it separately in #107.

## Specific items not taken and why

| Item | Why not |
|------|---------|
| Schema migrations v12-v19 | Fork-specific cleanup for your prior Nomic/768-dim branch. Burns 8 schema version numbers that don't help upstream users. |
| Action bar (Insert/Append/Create File) | Previously discussed in #97 — adds UI complexity we don't want right now. |
| JSONL orphan pruning at startup | Deletes JSONL files not found in SQLite, but JSONL is our source of truth. If SQLite is corrupt/incomplete, this permanently destroys conversation data. |
| Two-tier prompt (G-W2/G-W3) | LLM needs full workspace context every turn, not just on the first message. |
| Cheap restore (G-W1) | Breaks the system prompt — `loadWorkspace()` is what populates the data serialized into the prompt. |
| G-W3 flag + redundant context param fixes | Fix bugs introduced by this PR's refactor, not bugs on `main`. |
| `workspace?.context` guard fix | Real upstream bug — good catch. Fixed separately in #107. |
| ProviderHttpClient `require()` switch | Already fixed on `main` via the mobile compat work (`desktopRequire()`). |
| CRLF whitespace changes | ~1,500 lines of noise across 10 files that inflate the diff. |

## Going forward

One thing that would really help — please pull `main` so your fork is up to date before submitting PRs. Right now your branch has diverged significantly and every PR carries months of accumulated fork-specific changes mixed in with the new work. That makes it very hard to isolate what's actually new.

For the kind of issues you're finding, **opening issues might work better than PRs**. You clearly have good instincts for spotting inefficiencies — the dead per-turn fetches were a real find. If you file those as issues with the detail you put in your commit messages, we can implement fixes that fit cleanly on `main` without the merge headaches.

Thanks again for the time you put into this.
