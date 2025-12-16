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
// Database persistence with vault adapter
class VaultDatabaseManager {
  private readonly DB_PATH = '.nexus/cache.db';

  async loadDatabase(): Promise<Database> {
    const db = await createDatabase();  // In-memory initially

    // Load existing data if present
    if (await this.app.vault.adapter.exists(this.DB_PATH)) {
      const data = await this.app.vault.adapter.readBinary(this.DB_PATH);
      await db.deserialize(new Uint8Array(data));
    }

    return db;
  }

  async saveDatabase(db: Database): Promise<void> {
    const data = db.serialize();  // Export as binary
    await this.app.vault.adapter.writeBinary(this.DB_PATH, data);
  }
}
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
| Mobile | ⚠️ | Memory constrained - consider smaller batches or opt-in |

---

## 9. Summary

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
