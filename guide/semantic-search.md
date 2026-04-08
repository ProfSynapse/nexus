# Semantic Search

Search your vault by meaning, not just keywords. Nexus runs embeddings locally on your machine — no external API calls.

---

## How It Works

- **Desktop only** — Embeddings run locally via iframe-sandboxed transformers.js
- **Model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions, ~23MB)
- **Storage**: Vectors in `cache.db` (in the plugin directory) via sqlite-vec
- **First run** downloads the model (requires internet); subsequent runs are fully offline
- **Status bar** shows indexing progress — click to pause/resume

Use `searchManager.searchContent` with `semantic: true` to search notes by meaning.

---

## Conversation Memory Search

Use `searchManager.searchMemory` to search across past conversation turns and tool call traces.

### Two Modes

| Mode | Scope | Use Case |
|------|-------|----------|
| **Discovery** | Workspace-wide | "What have I discussed about authentication?" |
| **Scoped** | Session + N-turn window | "What did I just ask about this file?" |

### How It Works

- Conversations are chunked into Q&A pairs and embedded in real time as you chat
- **Multi-signal reranking**: semantic similarity + recency + session density + note references
- Background backfill indexes existing conversations automatically
- Uses the same local embedding model — no external API calls
