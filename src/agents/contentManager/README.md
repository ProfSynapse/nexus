# `src/agents/contentManager`

Content-focused agent: operations on the *contents* of notes/files (read/write/replace, plus batch transforms).

## What's Here

- `modes/` — individual content operations (single-file and batch).
- `utils/` — helper utilities used by content modes.

## Improvement Ideas

- Ensure all modes follow consistent parameter naming (`filePath`, `content`, etc.).
- Consider consolidating batch validation/execution plumbing if other agents adopt batching.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
