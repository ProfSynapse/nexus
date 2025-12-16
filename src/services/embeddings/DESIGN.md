# SQLite-vec Embeddings Integration Design

## Executive Summary

This document outlines a strategy for integrating vector embeddings into Nexus using:
- **`@dao-xyz/sqlite3-vec`** - Pre-built SQLite WASM with sqlite-vec (replaces sql.js)
- **Transformers.js** - Local WASM-based embedding generation
- **Note-level embeddings** - One embedding per note, no chunking
- **Single database** - All data in one SQLite file with native vector search

---

## 1. Architecture

### 1.1 Single Database Approach

Replace `sql.js` with `@dao-xyz/sqlite3-vec` to get both standard SQLite features AND native vector search in one package:

```
┌─────────────────────────────────────────────────────────────┐
│                   .nexus/cache.db                            │
│              (@dao-xyz/sqlite3-vec)                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Standard Tables (existing)     Vector Tables (new)          │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │ • conversations         │   │ • note_embeddings       │  │
│  │ • messages              │   │   (vec0 virtual table)  │  │
│  │ • workspaces            │   │                         │  │
│  │ • sessions              │   │ • embedding_metadata    │  │
│  │ • FTS4 search           │   │   (linked by rowid)     │  │
│  └─────────────────────────┘   └─────────────────────────┘  │
│                                                              │
│  ✓ JOINs work across all tables                             │
│  ✓ Single file to persist/sync                              │
│  ✓ Atomic transactions                                       │
│  ✓ Native KNN vector search                                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Why Single Database?

| Benefit | Description |
|---------|-------------|
| **JOINs** | Query embeddings + messages together in SQL |
| **Simplicity** | One file, one manager, one save cycle |
| **Atomic** | Transactions span embeddings and other data |
| **No sync issues** | Can't have embedding DB out of sync with main DB |

### 1.3 FTS5 Support

`@dao-xyz/sqlite3-vec` **supports FTS5** (wraps official `@sqlite.org/sqlite-wasm`).

**Use FTS5 for all full-text search** - better query syntax, BM25 ranking, and performance.

```typescript
import { createDatabase } from '@dao-xyz/sqlite3-vec';

const db = await createDatabase(':memory:');

db.exec(`CREATE VIRTUAL TABLE text_search USING fts5(content)`);
db.exec(`CREATE VIRTUAL TABLE vectors USING vec0(embedding float[384])`);
```

---

## 2. Package

### 2.1 Installation

```bash
npm install @dao-xyz/sqlite3-vec
```

### 2.2 Features

- SQLite + sqlite-vec **pre-compiled** into WASM
- Works in browser AND Node.js with unified API
- No custom build required
- MIT licensed
- ~5-6MB WASM bundle

### 2.3 Basic Usage

```typescript
import { createDatabase } from '@dao-xyz/sqlite3-vec';

// Create/open database
const db = await createDatabase(':memory:');

// Standard SQL works
db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT)`);

// Vector tables work
db.exec(`CREATE VIRTUAL TABLE embeddings USING vec0(embedding float[384])`);

// KNN search
const results = db.exec(`
  SELECT rowid, distance
  FROM embeddings
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT 10
`, [JSON.stringify(queryVector)]);
```

---

## 3. Schema Design

### 3.1 New Tables for Embeddings

```sql
-- ==================== NOTE EMBEDDINGS ====================

-- Vector storage (vec0 virtual table)
-- Note: vec0 tables only store vectors + rowid, metadata goes in separate table
CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
  embedding float[384]
);

-- Metadata linked to vec0 by rowid
CREATE TABLE IF NOT EXISTS embedding_metadata (
  rowid INTEGER PRIMARY KEY,  -- Matches note_embeddings rowid
  notePath TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embedding_meta_path ON embedding_metadata(notePath);
CREATE INDEX IF NOT EXISTS idx_embedding_meta_hash ON embedding_metadata(contentHash);
```

### 3.2 Querying Embeddings with Metadata

```sql
-- Find similar notes with full metadata
SELECT
  em.notePath,
  em.model,
  ne.distance
FROM note_embeddings ne
JOIN embedding_metadata em ON em.rowid = ne.rowid
WHERE ne.embedding MATCH ?
ORDER BY ne.distance
LIMIT 10;

-- Find notes similar to a specific note
SELECT
  em2.notePath,
  ne.distance
FROM note_embeddings ne
JOIN embedding_metadata em1 ON em1.notePath = ?
JOIN embedding_metadata em2 ON em2.rowid = ne.rowid
WHERE ne.embedding MATCH (
  SELECT embedding FROM note_embeddings WHERE rowid = em1.rowid
)
AND em2.notePath != ?
ORDER BY ne.distance
LIMIT 10;
```

### 3.3 Hybrid Search (Vector + Keyword)

Combine semantic similarity with keyword filtering using FTS5:

```sql
-- Create FTS5 table for note content (share rowid with vec0)
CREATE VIRTUAL TABLE IF NOT EXISTS note_content_fts USING fts5(
  content,
  content=''  -- External content mode
);

-- Hybrid search: semantic similarity + keyword filter
SELECT
  em.notePath,
  ne.distance
FROM note_embeddings ne
JOIN embedding_metadata em ON em.rowid = ne.rowid
JOIN note_content_fts fts ON fts.rowid = ne.rowid
WHERE ne.embedding MATCH ?
  AND fts.content MATCH 'automation OR workflow'
ORDER BY ne.distance
LIMIT 10;
```

This enables powerful queries like "find notes semantically similar to X that also mention 'project management'".

---

## 4. Embedding Generation

### 4.1 Transformers.js with CDN Loading

Following the WebLLM pattern for Obsidian compatibility:

```typescript
// src/services/embeddings/EmbeddingEngine.ts

import type * as TransformersTypes from '@huggingface/transformers';

let transformers: typeof TransformersTypes | null = null;

async function loadTransformers(): Promise<typeof TransformersTypes> {
  if (transformers) return transformers;

  // Load from CDN (works in Electron's sandboxed renderer)
  // @ts-ignore
  const module = await import('https://esm.run/@huggingface/transformers');
  transformers = module as typeof TransformersTypes;
  return transformers;
}

export class EmbeddingEngine {
  private extractor: any = null;
  private readonly MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  private readonly DIMENSIONS = 384;

  async initialize(): Promise<void> {
    const tf = await loadTransformers();
    this.extractor = await tf.pipeline(
      'feature-extraction',
      this.MODEL_ID,
      { quantized: true }
    );
  }

  async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.extractor) await this.initialize();

    const output = await this.extractor(text, {
      pooling: 'mean',
      normalize: true
    });

    return new Float32Array(output.data);
  }

  async dispose(): Promise<void> {
    this.extractor = null;
  }
}
```

### 4.2 Model Options

| Model | Dimensions | Size | Use Case |
|-------|-----------|------|----------|
| `Xenova/all-MiniLM-L6-v2` | 384 | 23MB | **Recommended** - Good balance |
| `Xenova/bge-small-en-v1.5` | 384 | 33MB | Higher quality |
| `Xenova/gte-small` | 384 | 30MB | Good multilingual |

---

## 5. Service Implementation

### 5.1 EmbeddingService

```typescript
// src/services/embeddings/EmbeddingService.ts

export class EmbeddingService {
  constructor(
    private db: Database,  // @dao-xyz/sqlite3-vec database
    private engine: EmbeddingEngine,
    private app: App
  ) {}

  async embedNote(notePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const contentHash = this.hashContent(content);

    // Check if already up to date
    const existing = this.db.exec(
      'SELECT rowid, contentHash FROM embedding_metadata WHERE notePath = ?',
      [notePath]
    );

    if (existing.length && existing[0].contentHash === contentHash) {
      return; // Already current
    }

    // Generate embedding
    const embedding = await this.engine.generateEmbedding(content);
    const embeddingJson = JSON.stringify(Array.from(embedding));

    // Insert or update
    if (existing.length) {
      // Update existing
      const rowid = existing[0].rowid;
      this.db.run(
        'UPDATE note_embeddings SET embedding = ? WHERE rowid = ?',
        [embeddingJson, rowid]
      );
      this.db.run(
        'UPDATE embedding_metadata SET contentHash = ?, updated = ? WHERE rowid = ?',
        [contentHash, Date.now(), rowid]
      );
    } else {
      // Insert new
      this.db.run(
        'INSERT INTO note_embeddings(embedding) VALUES (?)',
        [embeddingJson]
      );
      const rowid = this.db.exec('SELECT last_insert_rowid() as id')[0].id;
      this.db.run(
        `INSERT INTO embedding_metadata(rowid, notePath, model, contentHash, created, updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [rowid, notePath, 'all-MiniLM-L6-v2', contentHash, Date.now(), Date.now()]
      );
    }
  }

  async findSimilarNotes(notePath: string, limit = 10): Promise<SimilarNote[]> {
    return this.db.exec(`
      SELECT em.notePath, ne.distance
      FROM embedding_metadata source
      JOIN note_embeddings ne ON ne.embedding MATCH (
        SELECT embedding FROM note_embeddings WHERE rowid = source.rowid
      )
      JOIN embedding_metadata em ON em.rowid = ne.rowid
      WHERE source.notePath = ? AND em.notePath != ?
      ORDER BY ne.distance
      LIMIT ?
    `, [notePath, notePath, limit]);
  }

  async semanticSearch(query: string, limit = 10): Promise<SimilarNote[]> {
    const queryEmbedding = await this.engine.generateEmbedding(query);
    const embeddingJson = JSON.stringify(Array.from(queryEmbedding));

    return this.db.exec(`
      SELECT em.notePath, ne.distance
      FROM note_embeddings ne
      JOIN embedding_metadata em ON em.rowid = ne.rowid
      WHERE ne.embedding MATCH ?
      ORDER BY ne.distance
      LIMIT ?
    `, [embeddingJson, limit]);
  }

  async removeEmbedding(notePath: string): Promise<void> {
    const existing = this.db.exec(
      'SELECT rowid FROM embedding_metadata WHERE notePath = ?',
      [notePath]
    );
    if (existing.length) {
      this.db.run('DELETE FROM note_embeddings WHERE rowid = ?', [existing[0].rowid]);
      this.db.run('DELETE FROM embedding_metadata WHERE rowid = ?', [existing[0].rowid]);
    }
  }

  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(36);
  }
}
```

### 5.2 EmbeddingWatcher

```typescript
// src/services/embeddings/EmbeddingWatcher.ts

export class EmbeddingWatcher {
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly DEBOUNCE_MS = 2000;

  constructor(
    private embeddingService: EmbeddingService,
    private app: App
  ) {}

  start(): void {
    this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.scheduleReembedding(file.path);
      }
    });

    this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.scheduleReembedding(file.path);
      }
    });

    this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.embeddingService.removeEmbedding(file.path);
      }
    });

    this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        // Update path in metadata
        this.embeddingService.updatePath(oldPath, file.path);
      }
    });
  }

  private scheduleReembedding(notePath: string): void {
    const existing = this.debounceTimers.get(notePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(notePath);
      await this.embeddingService.embedNote(notePath);
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(notePath, timer);
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
```

---

## 6. Migration Path

### 6.1 Replace sql.js with @dao-xyz/sqlite3-vec

1. **Update package.json:**
   ```json
   {
     "dependencies": {
       "@dao-xyz/sqlite3-vec": "^x.x.x",
       "@huggingface/transformers": "^3.0.0"
     }
   }
   ```
   Remove: `"sql.js": "^1.13.0"`

2. **Update SQLiteCacheManager:**
   - Change import from `sql.js` to `@dao-xyz/sqlite3-vec`
   - API should be similar, test thoroughly

3. **Add embedding tables to schema.ts**

4. **Create EmbeddingService and EmbeddingWatcher**

5. **Wire into plugin lifecycle**

---

## 7. Obsidian/Electron Considerations

### 7.1 CDN Loading

Load Transformers.js from CDN (same pattern as WebLLM):
```typescript
const module = await import('https://esm.run/@huggingface/transformers');
```

### 7.2 Background Processing

Don't block Obsidian startup:
```typescript
setTimeout(async () => {
  await embeddingService.initialize();
  const notes = app.vault.getMarkdownFiles();
  for (const note of notes) {
    await embeddingService.embedNote(note.path);
    await new Promise(r => setTimeout(r, 50)); // Yield to UI
  }
}, 3000);
```

### 7.3 Memory Management

- Model: ~50-100MB in memory
- Embeddings: ~1.5KB per note (384 floats × 4 bytes)
- Dispose model when plugin unloads

### 7.4 Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | ✅ WASM works |
| macOS (Intel) | ✅ WASM works |
| Windows | ✅ WASM works |
| Linux | ✅ WASM works |
| Mobile | ⚠️ Memory constrained |

---

## 8. Summary

**Approach:**
1. Replace `sql.js` with `@dao-xyz/sqlite3-vec` (single database)
2. Use `Transformers.js` with `Xenova/all-MiniLM-L6-v2` for embeddings
3. Store vectors in `vec0` virtual table with native KNN search
4. Watch vault changes to keep embeddings in sync
5. One embedding per note (no chunking)

**Benefits:**
- Native vector search (no JS similarity calculations)
- JOINs across embeddings and existing tables
- Single database file
- Works offline, privacy-preserving
- ~50-100ms per note embedding time

---

## Sources

- [@dao-xyz/sqlite3-vec](https://www.npmjs.com/package/@dao-xyz/sqlite3-vec)
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec)
- [sqlite-vec WASM docs](https://alexgarcia.xyz/sqlite-vec/wasm.html)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
