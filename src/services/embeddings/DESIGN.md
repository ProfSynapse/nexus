# SQLite-vec Embeddings Integration Design

## Executive Summary

This document outlines a strategy for integrating vector embeddings into Nexus using:
- **`@dao-xyz/sqlite3-vec`** - Pre-built SQLite WASM with sqlite-vec (replaces sql.js)
- **Transformers.js** - Local WASM-based embedding generation
- **Note-level embeddings** - One embedding per note, no chunking
- **Trace-level embeddings** - One embedding per memory trace
- **Single database** - All data in one SQLite file with native vector search

## Key Design Decisions

### Semantic Search Flag Behavior

The `semantic: boolean` parameter is added to existing search modes (not a separate mode):

| Mode | `semantic: false` (default) | `semantic: true` |
|------|----------------------------|------------------|
| **searchContent** | Fuzzy + keyword search, returns **snippets** | Vector search, returns **ranked paths only** (no content) |
| **searchMemory** | Fuzzy/exact search, returns traces with content | Vector search, returns **ranked traces WITH content** |
| **searchDirectory** | Fuzzy path matching | ❌ Not applicable (path matching only) |

**Rationale:**
- **Notes**: Whole-note embeddings don't tell us WHERE in the note is relevant. Return paths only; LLM uses `contentManager.readContent` to get full content.
- **Traces**: No "read trace" tool exists in MemoryManager, so we must include content. Traces are small/structured, so this is acceptable.

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

### 2.3 Basic Usage (Obsidian Renderer - Current Implementation, Dec 2025)

Nexus runs sqlite3-vec in Obsidian’s Electron renderer using the **WASM build** (no native Node bindings). The low-level WASM bootstrapping is encapsulated by `SQLiteCacheManager`.

```typescript
// Current approach: sqlite3-vec WASM + manual persistence (export/deserialize)
// See: src/database/storage/SQLiteCacheManager.ts
import sqlite3InitModule from '@dao-xyz/sqlite3-vec/wasm';

// sqlite3.wasm is loaded via Obsidian's vault adapter (readBinary) and passed
// to sqlite3InitModule via instantiateWasm. The DB is kept in memory and
// persisted to `.nexus/cache.db` inside the vault.
```

**Key API Notes (Current):**
- Use the sqlite3-vec **WASM** build in Obsidian (renderer-safe); do not rely on `better-sqlite3`
- Vec0 tables auto-generate `rowid` (metadata stored separately and joined by rowid)
- Bind embeddings as BLOBs (`Buffer`/`Uint8Array`) and use `vec_distance_l2()` for KNN ranking

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

-- ==================== TRACE EMBEDDINGS ====================

-- Vector storage for memory traces
CREATE VIRTUAL TABLE IF NOT EXISTS trace_embeddings USING vec0(
  embedding float[384]
);

-- Metadata linked to vec0 by rowid
CREATE TABLE IF NOT EXISTS trace_embedding_metadata (
  rowid INTEGER PRIMARY KEY,  -- Matches trace_embeddings rowid
  traceId TEXT NOT NULL UNIQUE,
  workspaceId TEXT NOT NULL,
  sessionId TEXT,
  model TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trace_embed_id ON trace_embedding_metadata(traceId);
CREATE INDEX IF NOT EXISTS idx_trace_embed_workspace ON trace_embedding_metadata(workspaceId);
CREATE INDEX IF NOT EXISTS idx_trace_embed_session ON trace_embedding_metadata(sessionId);
```

### 3.2 Querying Embeddings with Metadata (Updated Dec 2025)

```sql
-- Find similar notes using vec_distance_l2 (NOT MATCH syntax)
-- Pass query embedding as Buffer parameter
SELECT
  em.notePath,
  em.model,
  vec_distance_l2(ne.embedding, ?) as distance
FROM note_embeddings ne
JOIN embedding_metadata em ON em.rowid = ne.rowid
ORDER BY distance
LIMIT 10;

-- Find notes similar to a specific note (two-step query)
-- Step 1: Get source embedding
SELECT ne.embedding FROM note_embeddings ne
JOIN embedding_metadata em ON em.rowid = ne.rowid
WHERE em.notePath = ?;

-- Step 2: Find similar notes using that embedding
SELECT
  em.notePath,
  vec_distance_l2(ne.embedding, ?) as distance
FROM note_embeddings ne
JOIN embedding_metadata em ON em.rowid = ne.rowid
WHERE em.notePath != ?
ORDER BY distance
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

  // ==================== TRACE EMBEDDINGS ====================

  /**
   * Embed a memory trace (called on trace creation)
   * Traces are small, so this is synchronous with trace creation
   */
  async embedTrace(
    traceId: string,
    workspaceId: string,
    sessionId: string | undefined,
    content: string
  ): Promise<void> {
    const contentHash = this.hashContent(content);

    // Check if already exists
    const existing = this.db.exec(
      'SELECT rowid, contentHash FROM trace_embedding_metadata WHERE traceId = ?',
      [traceId]
    );

    if (existing.length && existing[0].contentHash === contentHash) {
      return; // Already current
    }

    // Generate embedding
    const embedding = await this.engine.generateEmbedding(content);
    const embeddingJson = JSON.stringify(Array.from(embedding));

    if (existing.length) {
      // Update existing
      const rowid = existing[0].rowid;
      this.db.run(
        'UPDATE trace_embeddings SET embedding = ? WHERE rowid = ?',
        [embeddingJson, rowid]
      );
      this.db.run(
        'UPDATE trace_embedding_metadata SET contentHash = ? WHERE rowid = ?',
        [contentHash, rowid]
      );
    } else {
      // Insert new
      this.db.run(
        'INSERT INTO trace_embeddings(embedding) VALUES (?)',
        [embeddingJson]
      );
      const rowid = this.db.exec('SELECT last_insert_rowid() as id')[0].id;
      this.db.run(
        `INSERT INTO trace_embedding_metadata(rowid, traceId, workspaceId, sessionId, model, contentHash, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [rowid, traceId, workspaceId, sessionId, 'all-MiniLM-L6-v2', contentHash, Date.now()]
      );
    }
  }

  /**
   * Semantic search for similar traces (returns full trace content)
   * Used by searchMemory when semantic: true
   */
  async semanticTraceSearch(
    query: string,
    workspaceId: string,
    limit = 20
  ): Promise<TraceSearchResult[]> {
    const queryEmbedding = await this.engine.generateEmbedding(query);
    const embeddingJson = JSON.stringify(Array.from(queryEmbedding));

    // Query with workspace filter
    return this.db.exec(`
      SELECT
        tem.traceId,
        tem.workspaceId,
        tem.sessionId,
        te.distance
      FROM trace_embeddings te
      JOIN trace_embedding_metadata tem ON tem.rowid = te.rowid
      WHERE te.embedding MATCH ?
        AND tem.workspaceId = ?
      ORDER BY te.distance
      LIMIT ?
    `, [embeddingJson, workspaceId, limit]);
  }

  /**
   * Remove trace embedding when trace/session/workspace deleted
   */
  async removeTraceEmbedding(traceId: string): Promise<void> {
    const existing = this.db.exec(
      'SELECT rowid FROM trace_embedding_metadata WHERE traceId = ?',
      [traceId]
    );
    if (existing.length) {
      this.db.run('DELETE FROM trace_embeddings WHERE rowid = ?', [existing[0].rowid]);
      this.db.run('DELETE FROM trace_embedding_metadata WHERE rowid = ?', [existing[0].rowid]);
    }
  }

  /**
   * Remove all trace embeddings for a workspace
   */
  async removeWorkspaceTraceEmbeddings(workspaceId: string): Promise<number> {
    const traces = this.db.exec(
      'SELECT rowid FROM trace_embedding_metadata WHERE workspaceId = ?',
      [workspaceId]
    );
    for (const trace of traces) {
      this.db.run('DELETE FROM trace_embeddings WHERE rowid = ?', [trace.rowid]);
      this.db.run('DELETE FROM trace_embedding_metadata WHERE rowid = ?', [trace.rowid]);
    }
    return traces.length;
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

interface TraceSearchResult {
  traceId: string;
  workspaceId: string;
  sessionId: string | null;
  distance: number;
}
```

### 5.2 EmbeddingWatcher

```typescript
// src/services/embeddings/EmbeddingWatcher.ts

export class EmbeddingWatcher {
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  // 10-second debounce: prevents re-embedding on every keystroke
  // but short enough to not lose changes if vault closes unexpectedly
  private readonly DEBOUNCE_MS = 10000; // 10 seconds

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

## 6. Implementation Path (Fresh Build - No Legacy sql.js)

### 6.1 Context: No Migration Needed

**Important:** No users are on the current sql.js implementation yet. We have the luxury of building this fresh:

```
Old JSON files (.workspaces/, .conversations/)
        ↓
    LegacyMigrator (existing)
        ↓
JSONL (.nexus/) + @dao-xyz/sqlite3-vec cache (with embeddings)
```

- **JSONL** = source of truth (syncs via Obsidian Sync)
- **SQLite cache** = rebuilt from JSONL on startup (includes embeddings)
- **Embeddings** = generated fresh from vault content

No sql.js → sqlite3-vec migration code needed. Just replace sql.js entirely.

### 6.2 Implementation Steps

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

2. **Replace SQLiteCacheManager:**
   - Rewrite to use `@dao-xyz/sqlite3-vec` API
   - Include embedding tables in schema from the start
   - No migration logic needed - cache rebuilds from JSONL

3. **Create EmbeddingEngine** (Transformers.js CDN loading)

4. **Create EmbeddingService** (note + trace embedding methods)

5. **Create EmbeddingWatcher** (vault change events)

6. **Create IndexingQueue** (background initial indexing with progress)

7. **Integrate with VaultLibrarian** (add `semantic` param to modes)

---

## 7. Initial Indexing & Progress Tracking

### 7.1 The Challenge

First-time users may have **thousands of notes**. We need to:
- Not freeze Obsidian
- Show progress
- Be memory-conscious
- Resume if interrupted
- Allow user to cancel

### 7.2 IndexingQueue Implementation

```typescript
// src/services/embeddings/IndexingQueue.ts

export interface IndexingProgress {
  phase: 'idle' | 'loading_model' | 'indexing' | 'complete' | 'paused' | 'error';
  totalNotes: number;
  processedNotes: number;
  currentNote: string | null;
  estimatedTimeRemaining: number | null;  // seconds
  error?: string;
}

export class IndexingQueue extends EventEmitter {
  private queue: string[] = [];
  private isRunning = false;
  private isPaused = false;
  private abortController: AbortController | null = null;

  // Tuning parameters
  private readonly BATCH_SIZE = 1;           // Process one at a time for memory
  private readonly YIELD_INTERVAL_MS = 50;   // Yield to UI between notes
  private readonly SAVE_INTERVAL = 10;       // Save DB every N notes

  private processedCount = 0;
  private totalCount = 0;
  private startTime = 0;
  private processingTimes: number[] = [];    // Rolling average for ETA

  constructor(
    private embeddingService: EmbeddingService,
    private db: Database,
    private app: App
  ) {
    super();
  }

  /**
   * Start initial indexing of all notes
   */
  async startFullIndex(): Promise<void> {
    if (this.isRunning) return;

    const allNotes = this.app.vault.getMarkdownFiles();

    // Filter to notes not already indexed (or with changed content)
    const needsIndexing = await this.filterUnindexedNotes(allNotes);

    if (needsIndexing.length === 0) {
      this.emitProgress({ phase: 'complete', totalNotes: 0, processedNotes: 0, currentNote: null, estimatedTimeRemaining: null });
      return;
    }

    this.queue = needsIndexing.map(f => f.path);
    this.totalCount = this.queue.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];
    this.abortController = new AbortController();

    await this.processQueue();
  }

  /**
   * Filter to only notes that need (re)indexing
   */
  private async filterUnindexedNotes(notes: TFile[]): Promise<TFile[]> {
    const needsIndexing: TFile[] = [];

    for (const note of notes) {
      const content = await this.app.vault.cachedRead(note);
      const contentHash = this.hashContent(content);

      const existing = this.db.exec(
        'SELECT contentHash FROM embedding_metadata WHERE notePath = ?',
        [note.path]
      );

      // Needs indexing if: no embedding OR content changed
      if (!existing.length || existing[0].contentHash !== contentHash) {
        needsIndexing.push(note);
      }
    }

    return needsIndexing;
  }

  /**
   * Process the queue with memory-conscious batching
   */
  private async processQueue(): Promise<void> {
    this.isRunning = true;
    this.emitProgress({ phase: 'loading_model', totalNotes: this.totalCount, processedNotes: 0, currentNote: null, estimatedTimeRemaining: null });

    try {
      // Load model (one-time, ~50-100MB)
      await this.embeddingService.initialize();

      this.emitProgress({ phase: 'indexing', totalNotes: this.totalCount, processedNotes: 0, currentNote: null, estimatedTimeRemaining: null });

      while (this.queue.length > 0) {
        // Check for abort/pause
        if (this.abortController?.signal.aborted) {
          this.emitProgress({ phase: 'paused', totalNotes: this.totalCount, processedNotes: this.processedCount, currentNote: null, estimatedTimeRemaining: null });
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        const notePath = this.queue.shift()!;
        const noteStart = Date.now();

        try {
          this.emitProgress({
            phase: 'indexing',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: notePath,
            estimatedTimeRemaining: this.calculateETA()
          });

          // Process single note - memory released after each
          await this.embeddingService.embedNote(notePath);
          this.processedCount++;

          // Track timing for ETA
          const elapsed = Date.now() - noteStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift(); // Keep rolling window
          }

          // Periodic DB save (embeddings are already in DB, this ensures WAL flush)
          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`Failed to embed ${notePath}:`, error);
          // Continue with next note, don't fail entire queue
        }

        // Yield to UI - critical for responsiveness
        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Final save
      await this.db.save();

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });

    } catch (error) {
      this.emitProgress({
        phase: 'error',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        error: error.message
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateETA(): number | null {
    if (this.processingTimes.length < 3) return null;

    const avgTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
    const remaining = this.totalCount - this.processedCount;
    return Math.round((remaining * avgTime) / 1000); // seconds
  }

  /**
   * Pause indexing (can resume later)
   */
  pause(): void {
    this.isPaused = true;
    this.emitProgress({
      phase: 'paused',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: null,
      estimatedTimeRemaining: null
    });
  }

  /**
   * Resume paused indexing
   */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Cancel indexing entirely
   */
  cancel(): void {
    this.abortController?.abort();
    this.queue = [];
  }

  private async waitForResume(): Promise<void> {
    while (this.isPaused && !this.abortController?.signal.aborted) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private emitProgress(progress: IndexingProgress): void {
    this.emit('progress', progress);
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

### 7.3 Progress UI: Status Bar Integration

Use Obsidian's status bar API for progress display with pause/resume controls.

**Note:** Status bar is NOT available on Obsidian mobile.

```typescript
// src/services/embeddings/EmbeddingStatusBar.ts

import { Plugin, Notice } from 'obsidian';

export class EmbeddingStatusBar {
  private statusBarItem: HTMLElement | null = null;
  private textEl: HTMLSpanElement | null = null;
  private controlEl: HTMLSpanElement | null = null;

  constructor(
    private plugin: Plugin,
    private indexingQueue: IndexingQueue
  ) {}

  /**
   * Initialize status bar item
   * Call in plugin onload()
   */
  init(): void {
    // Create status bar item (returns HTMLElement)
    this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.addClass('nexus-embedding-status');

    // Text display
    this.textEl = this.statusBarItem.createEl('span', {
      text: '',
      cls: 'nexus-embedding-text'
    });

    // Clickable control (pause/resume)
    this.controlEl = this.statusBarItem.createEl('span', {
      text: '',
      cls: 'nexus-embedding-control'
    });
    this.controlEl.style.cursor = 'pointer';
    this.controlEl.style.marginLeft = '4px';

    // Wire up progress events
    this.indexingQueue.on('progress', this.handleProgress.bind(this));

    // Initially hidden
    this.hide();
  }

  private handleProgress(progress: IndexingProgress): void {
    switch (progress.phase) {
      case 'loading_model':
        this.show();
        this.setText('Loading embedding model...');
        this.setControl('');
        break;

      case 'indexing':
        this.show();
        const pct = Math.round((progress.processedNotes / progress.totalNotes) * 100);
        const eta = progress.estimatedTimeRemaining
          ? `~${Math.ceil(progress.estimatedTimeRemaining / 60)}m`
          : '';
        this.setText(`Indexing: ${pct}% (${progress.processedNotes}/${progress.totalNotes}) ${eta}`);
        this.setControl('⏸', () => this.indexingQueue.pause());
        break;

      case 'paused':
        this.show();
        this.setText(`Paused: ${progress.processedNotes}/${progress.totalNotes}`);
        this.setControl('▶', () => this.indexingQueue.resume());
        break;

      case 'complete':
        new Notice(`Embedding complete! ${progress.processedNotes} notes indexed.`);
        this.hide();
        break;

      case 'error':
        new Notice(`Embedding error: ${progress.error}`, 5000);
        this.hide();
        break;

      case 'idle':
        this.hide();
        break;
    }
  }

  private setText(text: string): void {
    if (this.textEl) this.textEl.textContent = text;
  }

  private setControl(text: string, onClick?: () => void): void {
    if (!this.controlEl) return;
    this.controlEl.textContent = text;
    this.controlEl.onclick = onClick || null;
  }

  private show(): void {
    if (this.statusBarItem) this.statusBarItem.style.display = 'flex';
  }

  private hide(): void {
    if (this.statusBarItem) this.statusBarItem.style.display = 'none';
  }
}
```

**Usage in main plugin:**

```typescript
// In main.ts onload()
export default class NexusPlugin extends Plugin {
  private embeddingStatusBar: EmbeddingStatusBar;
  private indexingQueue: IndexingQueue;

  async onload() {
    // ... other initialization

    // Create indexing queue
    this.indexingQueue = new IndexingQueue(embeddingService, db, this.app);

    // Create status bar (desktop only)
    this.embeddingStatusBar = new EmbeddingStatusBar(this, this.indexingQueue);
    this.embeddingStatusBar.init();

    // Start background indexing after delay
    setTimeout(() => {
      this.indexingQueue.startFullIndex();
    }, 3000);
  }
}
```

**Status bar appearance:**
```
| Indexing: 45% (450/1000) ~12m ⏸ |   ← Click ⏸ to pause
| Paused: 450/1000 ▶ |              ← Click ▶ to resume
```

**Optional CSS (styles.css):**
```css
.nexus-embedding-status {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nexus-embedding-control:hover {
  opacity: 0.7;
}
```

### 7.4 Memory Strategy

| Resource | Size | Strategy |
|----------|------|----------|
| Embedding model | ~50-100MB | Load once, keep in memory during indexing |
| Per-note embedding | ~1.5KB | Generate → save to DB → release immediately |
| Note content | Varies | Use `cachedRead()`, don't keep in memory |
| Queue | ~100 bytes/path | Keep full list (minimal memory) |

**Key principle:** Only ONE embedding in JS memory at a time. Generate → SQLite → GC.

### 7.5 Resumability

Indexing is **automatically resumable** because:
1. Each note's `contentHash` is stored in `embedding_metadata`
2. `filterUnindexedNotes()` checks existing hashes before queuing
3. If user closes Obsidian mid-index, next startup continues where left off

No explicit checkpoint file needed.

---

## 8. Obsidian/Electron Considerations

### 8.1 WASM Pitfalls & Electron Context

**Most browser WASM pitfalls don't apply to Obsidian (Electron):**

| Pitfall | Browser | Obsidian/Electron |
|---------|---------|-------------------|
| COOP/COEP headers | Required for SharedArrayBuffer | ❌ Not applicable - no HTTP |
| MIME types | Server must serve correctly | ❌ Local file loading |
| OPFS storage | Browser file system API | ⚠️ Use vault adapter instead |
| Module workers | May need polyfill | ⚠️ Use Blob URL pattern |
| Bundler config | Vite needs exclusions | ✅ Already external in esbuild |

**Key consideration: Storage location**

`@dao-xyz/sqlite3-vec` may default to OPFS or in-memory. For Obsidian, we need:
- Database in `.nexus/cache.db` (syncable with vault)
- Use Obsidian's vault adapter for persistence

```typescript
// In Nexus, SQLiteCacheManager handles vault persistence for sqlite3-vec WASM.
// See: src/database/storage/SQLiteCacheManager.ts
await sqliteCache.initialize(); // loads sqlite3.wasm + deserializes .nexus/cache.db
await sqliteCache.save();       // exports and writes .nexus/cache.db
```

**SharedArrayBuffer:** Electron typically enables this by default, but if issues arise:
```typescript
// In Electron main process (if needed)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
```

### 8.2 CDN Loading

Load Transformers.js from CDN (same pattern as WebLLM):
```typescript
const module = await import('https://esm.run/@huggingface/transformers');
```

### 8.3 Startup Sequence

```typescript
// In plugin onload()
setTimeout(async () => {
  // Don't block Obsidian startup
  const indexingQueue = new IndexingQueue(embeddingService, db, app);

  // Wire up progress UI
  indexingQueue.on('progress', updateStatusBar);

  // Start indexing (will skip already-indexed notes)
  await indexingQueue.startFullIndex();
}, 3000);
```

### 8.4 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS (Apple Silicon) | ✅ | WASM + WebGPU available |
| macOS (Intel) | ✅ | WASM works |
| Windows | ✅ | WASM works |
| Linux | ✅ | WASM works |
| Mobile (iOS/Android) | ❌ | **Disabled** - memory/battery constraints |

### 8.5 Mobile Detection & Disabling

Embeddings are **desktop-only**. Detect and skip on mobile:

```typescript
import { Platform } from 'obsidian';

export class EmbeddingService {
  private isEnabled: boolean;

  constructor(private app: App) {
    // Disable on mobile entirely
    this.isEnabled = !Platform.isMobile;
  }

  async initialize(): Promise<void> {
    if (!this.isEnabled) {
      console.log('[Embeddings] Disabled on mobile');
      return;
    }
    // ... normal initialization
  }

  async embedNote(notePath: string): Promise<void> {
    if (!this.isEnabled) return;
    // ... normal embedding
  }

  async semanticSearch(query: string): Promise<SimilarNote[]> {
    if (!this.isEnabled) return [];
    // ... normal search
  }
}
```

**In plugin initialization:**

```typescript
async onload() {
  // Skip embedding setup entirely on mobile
  if (Platform.isMobile) {
    console.log('[Nexus] Embeddings disabled on mobile');
    return;
  }

  // Desktop: initialize embeddings
  this.indexingQueue = new IndexingQueue(embeddingService, db, this.app);
  this.embeddingStatusBar = new EmbeddingStatusBar(this, this.indexingQueue);
  this.embeddingStatusBar.init();

  setTimeout(() => {
    this.indexingQueue.startFullIndex();
  }, 3000);
}
```

**Why no mobile:**
- Memory: Model requires ~50-100MB, devices are constrained
- Battery: Embedding generation is CPU-intensive
- No status bar: Can't show progress
- Sync: Desktop will generate embeddings, mobile just uses the database

---

## 9. Edge Cases & Error Handling

### 9.1 Note Content Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Empty notes** | Skip embedding | Check `content.trim().length === 0` before processing |
| **Very large notes** (>100KB) | Truncate to model limit | MiniLM max tokens ~512; truncate to ~2000 chars |
| **Binary/non-text** | Skip | Only process `.md` files |
| **Special characters** | Handle gracefully | Model handles Unicode; normalize whitespace |
| **Frontmatter only** | Skip or embed frontmatter | Strip YAML frontmatter, embed remaining content |
| **Embedded images/links** | Embed text portions | Strip `![[...]]` and `[[...]]` syntax, keep link text |

```typescript
function preprocessContent(content: string): string | null {
  // Strip frontmatter
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, '');

  // Strip image embeds, keep link text
  const withoutEmbeds = withoutFrontmatter
    .replace(/!\[\[.*?\]\]/g, '')           // Obsidian image embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')  // [[path|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1');    // [[path]] → path

  // Normalize whitespace
  const normalized = withoutEmbeds.replace(/\s+/g, ' ').trim();

  // Skip if too short
  if (normalized.length < 10) return null;

  // Truncate if too long (model context limit)
  const MAX_CHARS = 2000;
  return normalized.length > MAX_CHARS
    ? normalized.slice(0, MAX_CHARS)
    : normalized;
}
```

### 9.2 File System Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Rename during indexing** | Handle gracefully | Use `vault.on('rename')` to update metadata |
| **Delete during indexing** | Skip missing files | Catch file-not-found errors, remove from queue |
| **Symlinks** | Follow or skip | Obsidian resolves symlinks; treat as normal files |
| **Long file paths** | Handle gracefully | SQLite supports long TEXT values |
| **Special chars in path** | Store as-is | Use parameterized queries, avoid string escaping |
| **Vault moved** | Paths remain valid | Paths are relative to vault root |

```typescript
async embedNote(notePath: string): Promise<void> {
  try {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      // File was deleted or moved - remove stale embedding
      await this.removeEmbedding(notePath);
      return;
    }
    // ... continue with embedding
  } catch (error) {
    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      await this.removeEmbedding(notePath);
      return;
    }
    throw error;
  }
}
```

### 9.3 Database Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Corrupted database** | Rebuild from scratch | Delete `.nexus/cache.db`, re-index all notes |
| **Database locked** | Retry with backoff | Single-writer in Obsidian, shouldn't happen |
| **Disk full** | Fail gracefully, notify user | Catch write errors, pause indexing |
| **Schema mismatch** | Migrate or rebuild | Check `user_version`, run migrations |
| **Missing tables** | Create on startup | Use `CREATE TABLE IF NOT EXISTS` |
| **Orphaned embeddings** | Clean up | Periodic garbage collection |

```typescript
class EmbeddingDatabaseManager {
  private readonly SCHEMA_VERSION = 1;

  async initialize(): Promise<void> {
    // Check schema version
    const result = this.db.exec('PRAGMA user_version');
    const version = result[0]?.user_version ?? 0;

    if (version === 0) {
      // Fresh database - create tables
      await this.createTables();
      this.db.exec(`PRAGMA user_version = ${this.SCHEMA_VERSION}`);
    } else if (version < this.SCHEMA_VERSION) {
      // Run migrations
      await this.migrate(version, this.SCHEMA_VERSION);
    } else if (version > this.SCHEMA_VERSION) {
      // Database from newer version - rebuild
      console.warn('Database from newer version, rebuilding...');
      await this.rebuild();
    }
  }

  async cleanOrphanedEmbeddings(): Promise<number> {
    // Find embeddings for notes that no longer exist
    const orphans = this.db.exec(`
      SELECT em.rowid, em.notePath
      FROM embedding_metadata em
    `);

    let removed = 0;
    for (const row of orphans) {
      const exists = this.app.vault.getAbstractFileByPath(row.notePath);
      if (!exists) {
        this.db.run('DELETE FROM note_embeddings WHERE rowid = ?', [row.rowid]);
        this.db.run('DELETE FROM embedding_metadata WHERE rowid = ?', [row.rowid]);
        removed++;
      }
    }
    return removed;
  }
}
```

### 9.4 Network & Model Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **CDN unavailable** | Retry with backoff, then fail | 3 retries, notify user |
| **Partial model download** | Transformers.js handles | Cache management built into library |
| **Model cache corrupted** | Clear and re-download | Delete HuggingFace cache dir |
| **Different model version** | Re-embed all notes | Track model version in metadata |
| **Offline after first load** | Works offline | Model cached locally |

```typescript
async loadModel(retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await this.initialize();
      return;
    } catch (error) {
      if (attempt === retries) {
        new Notice(`Failed to load embedding model: ${error.message}`, 10000);
        throw error;
      }
      // Exponential backoff: 2s, 4s, 8s
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
  }
}

// Check model version on startup
async checkModelVersion(): Promise<boolean> {
  const stored = this.db.exec('SELECT model FROM embedding_metadata LIMIT 1');
  if (stored.length && stored[0].model !== this.MODEL_ID) {
    // Model changed - need to re-embed everything
    console.log(`Model changed from ${stored[0].model} to ${this.MODEL_ID}`);
    return false; // Trigger full re-index
  }
  return true;
}
```

### 9.5 Memory & Performance Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Large vault (10k+ notes)** | Batch processing | One note at a time, yield to UI |
| **Low memory** | Reduce batch size | Monitor memory if possible |
| **Very slow device** | Longer timeouts | Adaptive yield intervals |
| **User closes Obsidian mid-index** | Resume on restart | Content hash check resumes |
| **Many concurrent edits** | Debounce | 10-second debounce per file |

```typescript
// Adaptive performance based on device
class AdaptiveIndexer {
  private yieldInterval = 50; // Start conservative

  async adjustPerformance(): Promise<void> {
    // Measure time for a test embedding
    const start = performance.now();
    await this.embeddingService.generateEmbedding('test content');
    const elapsed = performance.now() - start;

    // Adjust yield interval based on embedding speed
    if (elapsed < 100) {
      this.yieldInterval = 10;  // Fast device
    } else if (elapsed < 500) {
      this.yieldInterval = 50;  // Normal device
    } else {
      this.yieldInterval = 100; // Slow device
    }
  }
}
```

### 9.6 Sync & Multi-Device Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Two devices open same vault** | Last write wins | No locking, accept data loss |
| **Sync conflict on cache.db** | Use latest, re-index stale | Content hash detects changes |
| **Mobile opens desktop-indexed vault** | Use existing embeddings | Read-only on mobile |
| **Desktop opens mobile-edited notes** | Re-embed changed notes | Content hash triggers update |
| **Sync deletes cache.db** | Rebuild | Normal startup behavior |

```typescript
// On startup, verify embeddings match current content
async verifyEmbeddings(): Promise<string[]> {
  const stale: string[] = [];
  const allNotes = this.app.vault.getMarkdownFiles();

  for (const note of allNotes) {
    const content = await this.app.vault.cachedRead(note);
    const currentHash = this.hashContent(content);

    const stored = this.db.exec(
      'SELECT contentHash FROM embedding_metadata WHERE notePath = ?',
      [note.path]
    );

    if (!stored.length || stored[0].contentHash !== currentHash) {
      stale.push(note.path);
    }
  }

  return stale; // Notes needing re-embedding
}
```

### 9.7 User Behavior Edge Cases

| Edge Case | Behavior | Implementation |
|-----------|----------|----------------|
| **Disable plugin mid-index** | Stop gracefully | AbortController, save progress |
| **Delete .nexus folder** | Rebuild from scratch | Normal startup creates folder/tables |
| **Change settings mid-index** | Apply after current batch | Check settings between notes |
| **Rapid enable/disable** | Debounce | Don't restart index within 5s |
| **Exclude folders from embedding** | Respect settings | Filter by path prefix |

```typescript
// Respect folder exclusions
filterExcludedNotes(notes: TFile[]): TFile[] {
  const excludedFolders = this.settings.excludeFolders || [];
  return notes.filter(note => {
    return !excludedFolders.some(folder =>
      note.path.startsWith(folder + '/')
    );
  });
}

// Graceful shutdown
async onunload(): Promise<void> {
  // Stop indexing gracefully
  this.indexingQueue?.cancel();

  // Wait for current operation to complete (max 5s)
  const timeout = Date.now() + 5000;
  while (this.indexingQueue?.isProcessing && Date.now() < timeout) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Final save
  await this.db?.save();
}
```

### 9.8 Error Recovery Summary

```typescript
// Centralized error handling
class EmbeddingErrorHandler {
  async handleError(error: Error, context: string): Promise<'retry' | 'skip' | 'abort'> {
    console.error(`[Embeddings] Error in ${context}:`, error);

    // Categorize error
    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      return 'skip'; // File gone, move on
    }

    if (error.message.includes('ENOSPC') || error.message.includes('disk full')) {
      new Notice('Disk full - pausing embedding indexing', 10000);
      return 'abort';
    }

    if (error.message.includes('network') || error.message.includes('fetch')) {
      return 'retry'; // Transient network error
    }

    if (error.message.includes('memory') || error.message.includes('OOM')) {
      new Notice('Low memory - pausing embedding indexing', 10000);
      return 'abort';
    }

    // Unknown error - log and skip
    return 'skip';
  }
}
```

---

## 10. Implementation Status (Dec 16, 2025)

### Completed Components ✅

| Component | File | Status |
|-----------|------|--------|
| **SQLiteCacheManager** | `src/database/storage/SQLiteCacheManager.ts` | ✅ sqlite3-vec WASM + vault persistence |
| **EmbeddingEngine** | `src/services/embeddings/EmbeddingEngine.ts` | ✅ Iframe sandbox (Transformers.js) |
| **EmbeddingService** | `src/services/embeddings/EmbeddingService.ts` | ✅ Note + trace embeddings |
| **EmbeddingWatcher** | `src/services/embeddings/EmbeddingWatcher.ts` | ✅ 10-second debounce |
| **IndexingQueue** | `src/services/embeddings/IndexingQueue.ts` | ✅ Background indexing with progress |
| **EmbeddingStatusBar** | `src/services/embeddings/EmbeddingStatusBar.ts` | ✅ Desktop-only progress display |
| **EmbeddingManager** | `src/services/embeddings/EmbeddingManager.ts` | ✅ High-level coordinator |
| **WASM Asset** | `sqlite3.wasm` | ✅ Bundled with plugin output |

### Pending Integration ⏳

| Task | Description |
|------|-------------|
| **Settings UI** | Add enable/disable toggle for embeddings |
| **Semantic trace tool** | Expose `EmbeddingService.semanticTraceSearch()` via an MCP mode (optional) |
| **Memory semantic search** | If desired, wire `searchMemory` to trace vector search (optional) |

### Key Implementation Details

1. **Renderer-safe SQLite**: sqlite3-vec WASM (`@dao-xyz/sqlite3-vec/wasm`) loaded from bundled `sqlite3.wasm`
2. **Vault persistence**: In-memory DB persisted to `.nexus/cache.db` via export/deserialize APIs
3. **Vec0 rowid quirk**: Auto-generates rowid; store metadata separately and join by rowid
4. **Buffer binding**: Bind embeddings as BLOBs (`Buffer`/`Uint8Array`)
5. **Search syntax**: Use `vec_distance_l2()` for KNN ranking (not `MATCH`)
6. **Embedding generation**: Transformers.js runs in an iframe sandbox and caches the model in IndexedDB

---

## 11. Summary

**Fresh Build Approach (No Legacy Migration):**
1. Replace `sql.js` with `@dao-xyz/sqlite3-vec` directly (no migration code)
2. Existing LegacyMigrator handles JSON → JSONL conversion
3. SQLite cache (with embeddings) rebuilds from JSONL on startup
4. Use `Transformers.js` with `Xenova/all-MiniLM-L6-v2` for embeddings
5. Store vectors in `vec0` virtual tables with native KNN search
6. Watch vault changes with 10-second debounce
7. Embed traces on creation when embedding service is available (plus backfill)
8. One embedding per note (no chunking), one per trace

**Data Flow:**
```
Old JSON → LegacyMigrator → JSONL (source of truth)
                              ↓
                         SQLite cache (rebuilt on startup)
                              ↓
                         Embeddings (generated from vault content)
```

**Semantic Search Flag (Current):**
- `searchContent` with `semantic: true` → returns ranked paths only (no content)
- `searchMemory` → keyword/FTS search (semantic trace search is not exposed as a tool yet)
- `searchDirectory` → no semantic option (path matching only)

**Benefits:**
- Clean implementation without legacy baggage
- Native vector search (no JS similarity calculations)
- JOINs across embeddings and existing tables
- Single database file
- Works offline, privacy-preserving
- ~50-100ms per note/trace embedding time
- Token-efficient: notes return paths only, LLM reads what it needs

---

## Sources

- [@dao-xyz/sqlite3-vec](https://www.npmjs.com/package/@dao-xyz/sqlite3-vec)
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec)
- [sqlite-vec WASM docs](https://alexgarcia.xyz/sqlite-vec/wasm.html)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
