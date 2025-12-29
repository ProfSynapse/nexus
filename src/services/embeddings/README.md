# Embeddings (Semantic Search)

This folder contains Nexus’s local embedding system used for semantic search and related “find by meaning” features.

## Runtime Behavior

- **Desktop-only**: disabled on mobile via `Platform.isMobile`
- **Local model execution**: embeddings are generated via a sandboxed iframe (`EmbeddingIframe`) that loads Transformers.js from a CDN; the model is cached locally (IndexedDB) after first download
- **Local vector storage**: embeddings are stored in `.nexus/cache.db` via `SQLiteCacheManager` (sqlite3-vec WASM + sqlite-vec `vec0`)

## Key Components

- `EmbeddingManager`: lifecycle coordinator (created by `PluginLifecycleManager`, exposed as `plugin.embeddingManager`)
- `EmbeddingService`: APIs for note + trace embeddings (`embedNote`, `semanticSearch`, `embedTrace`, …)
- `IndexingQueue`: background indexing (notes) + trace backfill
- `EmbeddingWatcher`: vault event watcher (debounced re-embedding)
- `EmbeddingStatusBar`: status bar progress + pause/resume controls

## Integration Points

- `searchManager.searchContent` uses `EmbeddingService.semanticSearch()` when `semantic: true`
- `ChatTraceService` can embed newly-created traces when given an `EmbeddingService` via `setEmbeddingService()`

## Troubleshooting

- Verify `sqlite3.wasm` exists in the plugin folder (`.obsidian/plugins/nexus/sqlite3.wasm` or legacy `.obsidian/plugins/claudesidian-mcp/sqlite3.wasm`)
- Check Obsidian console logs prefixed with `[EmbeddingManager]`, `[EmbeddingEngine]`, `[IndexingQueue]`, `[SQLiteCacheManager]`

