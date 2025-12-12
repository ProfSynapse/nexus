# `src/agents/vaultManager`

Filesystem-focused agent: operations on *where files are* in the vault (folders, paths, structural changes).

## What's Here

- `modes/` — folder/file operations exposed as tools.
- `utils/` — path and vault helper utilities.

## Improvement Ideas

- Centralize path normalization rules (especially on Windows vs POSIX).
- Keep “content edits” out of this agent; delegate to `contentManager` for separation.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
