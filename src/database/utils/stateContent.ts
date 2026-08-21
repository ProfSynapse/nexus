/**
 * Location: src/database/utils/stateContent.ts
 *
 * Purpose: derive the `states` columns that are denormalized out of a state
 * snapshot's JSON content, in ONE place.
 *
 * A state's content lives in the JSONL event store; SQLite only caches
 * metadata. Two fields inside that content are needed by every list view:
 *
 * - `state.metadata.isArchived` — the archive filter (issue #219). Reading it
 *   from JSONL cost one full workspace-stream parse per state, so listing N
 *   states parsed O(N^2) events.
 * - `context.activeTask` — the description shown for states created by the
 *   `createState` tool, which supplies no explicit description.
 *
 * Both are derived here so that every writer of the `states` table — the
 * repository (live writes) and WorkspaceEventApplier (JSONL replay / sync) —
 * produces byte-identical columns. If they diverge, a cache rebuild silently
 * changes what the UI shows, which is the failure mode `rebuildCache()` is
 * most likely to hide.
 *
 * Related files:
 * - src/database/repositories/StateRepository.ts
 * - src/database/sync/WorkspaceEventApplier.ts
 * - src/database/schema/SchemaMigrator.ts (v15 backfill)
 */

/** Columns derivable from a state snapshot's content. */
export interface DerivedStateMetadata {
  /** True only when the snapshot explicitly carries `state.metadata.isArchived === true`. */
  isArchived: boolean;
  /**
   * `context.activeTask`, trimmed. Used as the SQLite `description` fallback
   * when the save event carried no explicit description.
   */
  activeTask?: string;
}

interface StateContentShape {
  context?: { activeTask?: unknown };
  state?: { metadata?: { isArchived?: unknown } };
}

/**
 * Derive the denormalized columns from a state snapshot's content.
 * Anything unparseable or unexpected yields `{ isArchived: false }` — the
 * conservative answer, because a state wrongly hidden from a list is worse
 * than one wrongly shown.
 */
export function deriveStateMetadata(content: unknown): DerivedStateMetadata {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return { isArchived: false };
  }

  const shape = content as StateContentShape;
  const isArchived = shape.state?.metadata?.isArchived === true;
  const rawTask = shape.context?.activeTask;
  const activeTask = typeof rawTask === 'string' && rawTask.trim().length > 0
    ? rawTask.trim()
    : undefined;

  return { isArchived, activeTask };
}

/**
 * Derive the columns from a serialized snapshot (the `stateJson` carried by
 * `state_saved` / `state_updated` events). Returns null when the input is
 * absent or not valid JSON, so callers can leave the columns untouched
 * instead of overwriting them with a guess.
 */
export function deriveStateMetadataFromJson(stateJson: string | null | undefined): DerivedStateMetadata | null {
  if (typeof stateJson !== 'string' || stateJson.length === 0) {
    return null;
  }

  try {
    return deriveStateMetadata(JSON.parse(stateJson));
  } catch {
    return null;
  }
}

/**
 * The value the SQLite `description` column should hold: the explicit
 * description when one was supplied, otherwise the snapshot's activeTask.
 */
export function resolveStateDescription(
  explicit: string | null | undefined,
  derived: DerivedStateMetadata | null
): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }
  return derived?.activeTask ?? null;
}
