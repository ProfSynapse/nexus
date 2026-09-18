/**
 * Location: src/services/embeddings/CacheSavePolicy.ts
 * Purpose: decide how often background indexing asks the SQLite cache to write
 *          a snapshot, and give a failed snapshot a message that says what
 *          actually failed.
 * Used by: IndexingQueue, ConversationIndexer, TraceIndexer. All three had the
 *          same flat "every ten items" rule and three different reactions to a
 *          save that threw.
 *
 * Why a policy rather than a constant. A save exports the entire database out
 * of the WASM heap into one contiguous buffer and the backing store copies it
 * again, so its cost scales with the database, not with the number of items
 * indexed since the last one. Ten items is nearly free on a 4 MB cache and is
 * roughly 380 ms of wall clock every ten notes on the 152 MB cache that
 * motivated docs/plans/sqlite-cache-persistence-plan.md.
 *
 * Mobile: no imports, nothing platform specific. Deliberately so, since this
 * runs on the same path on a phone.
 */

/**
 * Wall clock one save costs, per megabyte of database.
 *
 * Measured, not guessed: the Phase 3 spike
 * (docs/plans/sqlite-cache-persistence-spike-findings.md section 5c and 5d)
 * timed the real desktop path end to end at 161 ms for a 56.1 MB database and
 * 378 ms for a 152.4 MB one, which is 2.9 and 2.5 ms per megabyte. The lower
 * figure is used because it is the one measured at the size where the cadence
 * matters, and because underestimating the cost saves more often rather than
 * less, which is the safer direction to be wrong in.
 */
const SAVE_COST_MS_PER_MB = 2.5;

const BYTES_PER_MB = 1024 * 1024;

/**
 * The share of wall clock a full index may spend writing snapshots.
 *
 * One percent, which at 152 MB puts a floor of about 38 s between saves. That
 * is the number that turns roughly 1800 exports per full index into roughly
 * one hundred, and it is expressed as a budget rather than a constant so it
 * stays right when the database is 40 MB or 400 MB.
 */
const SAVE_WALL_CLOCK_BUDGET = 0.01;

/**
 * Amortised save cost a single indexed item may carry, in milliseconds.
 *
 * An embedding call is at best tens of milliseconds and usually far more, so
 * four milliseconds of snapshot cost per item is a few percent at worst. At
 * 152 MB this asks for a save every 95 items; at 16 MB it asks for one every
 * 10, which is what the code did before and is correct at that size.
 */
const SAVE_COST_MS_PER_ITEM = 4;

/** However large the database gets, do not let more than this many items ride on one save. */
const MAX_ITEMS_BETWEEN_SAVES = 250;

/**
 * Items that may be at risk before a save is due whatever the clock says.
 *
 * This is a ceiling, not a floor, and it is the only rule here that overrides
 * the time floor. The two floors below decide how cheap the run is; this one
 * decides how much work a crash may cost, and when they disagree this one wins.
 *
 * Why fifty. The unit of loss is one embedding: an item that is in the
 * in-memory database and in no snapshot has to be recomputed at full provider
 * API cost after a crash, and the crash this whole plan exists for is
 * reproducible. The unit of spend is one save, about 2.5 ms per megabyte
 * (378 ms measured at 152.4 MB, spike findings section 5d). At the 153 MB that
 * motivated the plan, fifty puts roughly six saves in a 300 note run, about
 * 2.3 s of snapshot cost across the run, against 32 saves before the
 * size-aware cadence and exactly one after it. So it buys back a bounded worst
 * case for a few seconds per run and keeps most of the reduction.
 *
 * It is deliberately a flat count rather than a share of the database size.
 * Fifty lost embeddings cost the same whether the cache is 4 MB or 1 GB, so
 * the number that bounds them must not scale with the cache. At a small cache
 * the item floor is already below this, so this rule never fires there; see
 * the cadence tests.
 */
export const MAX_ITEMS_AT_RISK = 50;

/** However large the database gets, do not wait longer than this between saves. */
const MAX_MS_BETWEEN_SAVES = 5 * 60 * 1000;

/** What one save is expected to cost, in milliseconds, at this database size. */
export function estimateSaveCostMs(sizeBytes: number | null): number {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return 0;
  }
  return (sizeBytes / BYTES_PER_MB) * SAVE_COST_MS_PER_MB;
}

export interface SaveCadenceDecision {
  /** Items that must be processed before the next save. */
  items: number;
  /** Milliseconds that must pass before the next save. */
  intervalMs: number;
  /** What one save is expected to cost at the current size. */
  estimatedSaveCostMs: number;
}

/**
 * Turn a database size into a cadence.
 *
 * Both numbers are floors and BOTH have to be met, which is the "whichever is
 * later" in Option B of the plan. The item floor keeps a fast indexer from
 * saving every few hundred milliseconds; the time floor keeps a slow one from
 * saving more often than the budget allows. An unknown or empty database
 * (`null`, or a fresh install before anything has been written) produces no
 * time floor at all, because a save that costs nothing does not need one.
 *
 * Floors only. The ceiling that bounds how much data may ride on one save is
 * MAX_ITEMS_AT_RISK, and it lives in SaveCadence.shouldSave() because it is
 * measured from the last save that succeeded, which a size cannot know.
 */
export function computeSaveCadence(sizeBytes: number | null, minItems: number): SaveCadenceDecision {
  const estimatedSaveCostMs = estimateSaveCostMs(sizeBytes);
  const costDrivenItems = Math.ceil(estimatedSaveCostMs / SAVE_COST_MS_PER_ITEM);
  return {
    items: Math.min(Math.max(minItems, costDrivenItems), Math.max(minItems, MAX_ITEMS_BETWEEN_SAVES)),
    intervalMs: Math.min(estimatedSaveCostMs / SAVE_WALL_CLOCK_BUDGET, MAX_MS_BETWEEN_SAVES),
    estimatedSaveCostMs
  };
}

/**
 * The part of SQLiteCacheManager this policy needs.
 *
 * Optional on purpose. `getLastSavedBytes()` costs nothing (it is the byte
 * count of the last write, or the size of the blob that was loaded at
 * startup), but a caller holding an older or partial stand-in for the cache
 * manager must degrade to the flat floor rather than throw on a save path.
 */
export interface CacheSizeSource {
  getLastSavedBytes?: () => number | null;
}

/** Size of the persisted cache in bytes, or null when nothing can say. */
export function readCacheSizeBytes(db: CacheSizeSource): number | null {
  try {
    return typeof db.getLastSavedBytes === 'function' ? db.getLastSavedBytes() : null;
  } catch {
    return null;
  }
}

export interface SaveCadenceOptions {
  /** Never save more often than this many items, whatever the size says. */
  minItems: number;
  db: CacheSizeSource;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Counts items and elapsed time between snapshots.
 *
 * One instance per indexing run. It re-reads the database size on every
 * decision rather than caching it, because the size is what the run is busy
 * growing, and reading it is a field access.
 *
 * Two item counters, and the difference between them is the point. One counts
 * from the last save that was ATTEMPTED and paces the run: a save that failed
 * cost the same hundreds of milliseconds as one that worked, so the next
 * attempt has to be earned again. The other counts from the last save that
 * SUCCEEDED and measures exposure: only a snapshot that actually landed makes
 * an item safe, so a failed attempt does not reduce what a crash would cost.
 * Pacing off the wrong one of those is what let 300 rows ride on a single save
 * in the live measurement that motivated the ceiling.
 */
export class SaveCadence {
  private readonly minItems: number;
  private readonly db: CacheSizeSource;
  private readonly now: () => number;
  private itemsSinceAttempt = 0;
  private itemsSinceSuccess = 0;
  private lastAttemptAt: number;

  constructor(options: SaveCadenceOptions) {
    this.minItems = Math.max(1, options.minItems);
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.lastAttemptAt = this.now();
  }

  /** One item finished. Call this only for items that actually changed the database. */
  recordItem(): void {
    this.itemsSinceAttempt++;
    this.itemsSinceSuccess++;
  }

  /** How many items are in the database and in no snapshot: what a crash would cost. */
  itemsAtRisk(): number {
    return this.itemsSinceSuccess;
  }

  /**
   * Whether a save is due.
   *
   * Two ways to be due, and they answer different questions.
   *
   * The floors are the cheap run: enough items AND enough time since the last
   * attempt, which is the "whichever is later" of Option B in the plan.
   *
   * The ceiling is the bounded loss: once MAX_ITEMS_AT_RISK items sit in the
   * database with no snapshot covering them, a save is due whatever the clock
   * says. It has to override the time floor, because the time floor is where
   * the exposure came from: at 153 MB it is about 38 s, longer than an entire
   * short incremental run, so nothing periodic could fire inside one.
   *
   * The ceiling still respects the caller's flat floor. Without that, a failing
   * save would be retried on the very next item forever, since a failure never
   * clears the exposure that is asking for it, and each retry costs the full
   * export. So the sequence after a failure is: retry every `minItems` items
   * rather than every item, and rather than not until the time floor, which
   * would leave the rest of the run uncovered.
   */
  shouldSave(): boolean {
    const { items, intervalMs } = this.decide();
    if (this.itemsSinceSuccess >= MAX_ITEMS_AT_RISK && this.itemsSinceAttempt >= this.minItems) {
      return true;
    }
    return this.itemsSinceAttempt >= items && this.now() - this.lastAttemptAt >= intervalMs;
  }

  /**
   * A save was attempted, successfully or not.
   *
   * A failed attempt resets the pacing counters as a successful one does. The
   * plan measures the interval from the last successful save, but a save that
   * is failing is failing because the allocator refused a buffer the size of
   * the database, and asking again on the very next item spends the same
   * hundreds of milliseconds to be refused again. What a failed attempt does
   * NOT do is reduce the exposure: `itemsSinceSuccess` is untouched here, so
   * the ceiling keeps asking, at the flat floor rather than at the full
   * cadence, until a save lands.
   */
  markSaveAttempt(): void {
    this.itemsSinceAttempt = 0;
    this.lastAttemptAt = this.now();
  }

  /**
   * A save landed: everything written before it is now on disk.
   *
   * Call this only where the save is known to have succeeded, which means
   * after an awaited `SQLiteCacheManager.save()` returned without throwing.
   * That resolution is a real guarantee rather than a hopeful one: `saveToFile`
   * joins an in-flight export only when the write generation has not moved
   * since that export started, and schedules a follow-up otherwise, so a
   * resolved save covers every write this caller had made when it asked.
   */
  markSaveSuccess(): void {
    this.itemsSinceSuccess = 0;
  }

  /** The cadence in force right now. Exposed for tests and for log lines. */
  decide(): SaveCadenceDecision {
    return computeSaveCadence(readCacheSizeBytes(this.db), this.minItems);
  }
}

/** Which save failed: the one that runs every so often, or the one at the end of a run. */
export type CacheSaveStage = 'periodic' | 'final';

/**
 * The message a failed cache save gets.
 *
 * It exists because the old message was `Failed to embed <path>`: the periodic
 * save sat inside the per-item try, so a persistence failure was reported as
 * an embedding failure, attributed to whichever item happened to be tenth.
 * Nothing in that line, or anywhere near it, contained the word "save", which
 * is why the reported stack was the only clue that this was persistence.
 *
 * The byte count is in the message because it is the number that explains the
 * failure: a `RangeError: Array buffer allocation failed` is the allocator
 * refusing one contiguous request of roughly that size.
 */
export function describeCacheSaveFailure(
  source: string,
  stage: CacheSaveStage,
  sizeBytes: number | null
): string {
  const size = sizeBytes === null || sizeBytes <= 0
    ? 'last snapshot size unknown'
    : `last snapshot ${sizeBytes} bytes`;
  const when = stage === 'final' ? 'final save' : 'periodic save';
  return (
    `[${source}] Failed to save the cache (${when}, ${size}). ` +
    'Nothing failed to embed: the vectors are in the in-memory database and ' +
    'the next successful save writes them.'
  );
}
