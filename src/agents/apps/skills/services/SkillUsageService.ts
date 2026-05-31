/**
 * SkillUsageService — cross-workspace usage history for a skill (§9).
 *
 * Located at: src/agents/apps/skills/services/SkillUsageService.ts
 * Inversion of workspace activity: a workspace tracks "what happened in this
 * folder", a skill tracks "what I accomplished WITH this skill, wherever I
 * was." Tool-call traces are stamped with the session's active skill ids by
 * ToolCallTraceService (§9 step 2); this service queries `memory_traces` for
 * rows whose `metadataJson.activeSkills` array contains the skillId, grouped by
 * workspace, and folds the result into loadSkill's return (§12).
 *
 * Best-effort throughout — the caller wraps getUsageHistory in try/catch and a
 * failure must never break a skill load.
 * See docs/plans/skills-protocol-integration-plan.md §9 / §12.
 */

import type { SQLiteCacheManager } from '../../../../database/storage/SQLiteCacheManager';

const PER_WORKSPACE_CAP = 10;

export interface SkillUsageHistory {
  lastUsedAt?: number;
  totalUsages: number;
  byWorkspace: Array<{
    workspaceId: string;
    recentFiles: Array<{ path: string; action?: string; at: number }>;
    states: Array<{ name: string; savedAt: number }>;
    recentActions: Array<{ tool: string; summary: string; at: number }>;
  }>;
}

interface TraceRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  timestamp: number;
  type: string;
  content: string | null;
  metadataJson: string | null;
}

/** Mutable accumulator for one workspace while grouping. */
interface WorkspaceBucket {
  workspaceId: string;
  recentFiles: Array<{ path: string; action?: string; at: number }>;
  states: Array<{ name: string; savedAt: number }>;
  recentActions: Array<{ tool: string; summary: string; at: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SkillUsageService {
  constructor(private sqlite: SQLiteCacheManager) {}

  /**
   * Fetch cross-workspace usage history for a skill.
   *
   * @param skillId The skill id (e.g. "claude/essay-editor")
   * @param limit   Max trace rows to scan (recency-ordered)
   */
  async getUsageHistory(skillId: string, limit = 50): Promise<SkillUsageHistory> {
    // LIKE is a cheap prefilter — the skillId is JSON-encoded inside the
    // activeSkills array (e.g. ...,"claude/essay-editor",...). We re-confirm in
    // JS below to discard false positives (e.g. a skillId that is a prefix of
    // another, or a stray match elsewhere in the JSON).
    //
    // Escape LIKE wildcards (% and _) in the skillId so they match literally and
    // can't over-match (which, combined with the LIMIT, would under-report by
    // crowding out genuine rows). Parameterized already, so this is purely about
    // LIKE-pattern semantics, not injection.
    const escapedId = skillId.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = await this.sqlite.query<TraceRow>(
      'SELECT id, workspaceId, sessionId, timestamp, type, content, metadataJson ' +
      "FROM memory_traces WHERE metadataJson LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT ?",
      [`%"${escapedId}"%`, limit]
    );

    const buckets = new Map<string, WorkspaceBucket>();
    let totalUsages = 0;
    let lastUsedAt: number | undefined;

    for (const row of rows) {
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadataJson ?? '') as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!isRecord(metadata)) {
        continue;
      }

      // Confirm the skill is actually in the activeSkills array — discard
      // LIKE false positives.
      const activeSkills = metadata.activeSkills;
      if (!Array.isArray(activeSkills) || !activeSkills.includes(skillId)) {
        continue;
      }

      totalUsages += 1;
      if (lastUsedAt === undefined || row.timestamp > lastUsedAt) {
        lastUsedAt = row.timestamp;
      }

      const bucket = buckets.get(row.workspaceId) ?? {
        workspaceId: row.workspaceId,
        recentFiles: [],
        states: [],
        recentActions: [],
      };

      // Resolve a human tool label from the canonical metadata (tool.id) and a
      // short content summary.
      const tool = isRecord(metadata.tool) ? metadata.tool : undefined;
      const toolLabel =
        (typeof tool?.id === 'string' && tool.id) ||
        (typeof tool?.agent === 'string' && typeof tool?.mode === 'string'
          ? `${tool.agent} ${tool.mode}`
          : undefined) ||
        row.type ||
        'unknown';
      const summary = (row.content ?? '').slice(0, 140);

      if (bucket.recentActions.length < PER_WORKSPACE_CAP) {
        bucket.recentActions.push({ tool: toolLabel, summary, at: row.timestamp });
      }

      // recentFiles: canonical trace metadata stores affected file paths in
      // input.files (see TraceMetadataBuilder.normalizeInput / extractRelatedFiles).
      const input = isRecord(metadata.input) ? metadata.input : undefined;
      const inputFiles = input && Array.isArray(input.files) ? input.files : undefined;
      if (inputFiles) {
        for (const file of inputFiles) {
          if (typeof file === 'string' && bucket.recentFiles.length < PER_WORKSPACE_CAP) {
            bucket.recentFiles.push({ path: file, action: toolLabel, at: row.timestamp });
          }
        }
      }

      // states: OUT OF SCOPE for this slice — saved states are not yet stamped
      // with activeSkills.
      // TODO(states): stamp activeSkills onto saved states (SaveStateData/tagsJson)
      // and surface them here.

      buckets.set(row.workspaceId, bucket);
    }

    return {
      lastUsedAt,
      totalUsages,
      byWorkspace: Array.from(buckets.values()),
    };
  }
}
