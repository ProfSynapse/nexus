# VaultLibrarian Agent

VaultLibrarian provides search and navigation tools over your vault content.

## Modes

- `searchContent`: Search note content and filenames.
  - `semantic: false` → keyword/fuzzy search (returns snippets + `score`)
  - `semantic: true` → semantic search (returns ranked `filePath` + frontmatter; no snippets)
- `searchDirectory`: Fuzzy search for files/folders within provided `paths`
- `searchMemory`: Search workspace/session memory traces (keyword/FTS)
- `batch`: Run multiple “universal” searches concurrently (best for multi-query workflows)

## Semantic Content Search

Use `vaultLibrarian.searchContent` with `semantic: true` to find notes by meaning (conceptual similarity). On desktop, Nexus indexes notes in the background and stores vectors in `.nexus/cache.db` (status bar shows progress). On mobile, semantic search is disabled.

Example tool args:

```json
{
  "query": "notes about vector databases and similarity search",
  "semantic": true,
  "limit": 10,
  "paths": ["Research/**"]
}
```

For semantic results, read the full note content via `contentManager.readContent` using the returned `filePath`.

