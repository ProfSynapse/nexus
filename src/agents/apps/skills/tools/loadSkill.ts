/**
 * LoadSkillTool — activation tool for the Skills app (loadWorkspace-shaped).
 *
 * Located at: src/agents/apps/skills/tools/loadSkill.ts
 * Returns the SKILL.md body, the skill folder listing, and a nudge to read
 * bundled files with the existing `content read` tool. Usage history (§9)
 * arrives in a later phase. On a bare ambiguous name it returns the
 * recency-ordered alternatives instead of silently guessing.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime } from '../services/SkillsContext';
import { SkillUsageService, type SkillUsageHistory } from '../services/SkillUsageService';

interface LoadSkillParams extends CommonParameters {
  name: string;
  source?: string;
  recursive?: boolean;
  includeHistory?: boolean;
  // Injected at the top level by ToolBatchExecutionService.applyContextDefaults
  // (CLI-first contract) — used to attribute usage history to the session (§9).
  sessionId?: string;
}

export class LoadSkillTool extends BaseTool<LoadSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'loadSkill',
      'Load Skill',
      'Load a skill — returns its SKILL.md body, the skill folder listing, a nudge to ' +
      'open bundled files with the existing `content read` tool, and recent usage history. ' +
      'These are instructions to read and follow — do NOT auto-execute them.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: LoadSkillParams): Promise<CommonResult> {
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    // Scan + sync first so the index reflects the current on-disk state.
    const parsed = await r.rt.scanner.scan();
    await r.rt.index.syncFromScan(parsed);

    const matches = await r.rt.index.findByName(params.name, params.source);
    if (matches.length === 0) {
      const suffix = params.source ? ` for provider "${params.source}"` : '';
      return this.prepareResult(false, undefined, `No skill named "${params.name}"${suffix}`);
    }

    // Most-recently-loaded match wins (recency-ordered by findByName).
    const record = matches[0];

    // Read the SKILL.md body.
    const skillMdPath = normalizePath(`${record.vaultPath}/SKILL.md`);
    let instructions: string;
    try {
      instructions = await r.rt.vaultAdapter.read(skillMdPath);
    } catch {
      return this.prepareResult(false, undefined,
        `Could not read SKILL.md for skill "${record.name}" (${record.provider}) at ${skillMdPath}`);
    }

    // Build the skill folder structure for navigation (loadWorkspace-shaped):
    // top-level items by default (folders marked with a trailing `/`), or the
    // full recursive file tree when `recursive` is true. Best-effort — a missing
    // listing should not fail the load.
    const structure = await this.buildStructure(
      r.rt.vaultAdapter,
      record.vaultPath,
      params.recursive === true
    );

    // Stamp recency so this load surfaces first next time.
    await r.rt.index.touchLoaded(record.id);

    const skillId = `${record.provider}/${record.name}`;

    // Register the loaded skill as active for this session so subsequent
    // tool-call traces are attributed to it (§9). Best-effort — attribution must
    // never break a load.
    try {
      if (params.sessionId) {
        r.rt.sessionContextManager?.addActiveSkill(params.sessionId, skillId);
      }
    } catch {
      /* attribution is best-effort */
    }

    // Fetch cross-workspace usage history for this skill (§9). Best-effort and
    // opt-out via includeHistory:false.
    let usageHistory: SkillUsageHistory | undefined;
    if (params.includeHistory !== false) {
      try {
        const usage = new SkillUsageService(r.rt.sqlite);
        usageHistory = await usage.getUsageHistory(skillId);
      } catch {
        /* best-effort — omit usageHistory on error */
      }
    }

    // loadWorkspace-shaped payload (§12): instructions + folder structure nested
    // in `skill`, top-level nudge. `structure` mirrors loadWorkspace's
    // `workspaceStructure` (string[], folders trailing `/`, recursive opt-in).
    // `alternatives` surfaces the other recency-ordered matches when a bare name
    // was ambiguous across providers. `usageHistory` is omitted when
    // includeHistory:false or on fetch error.
    return this.prepareResult(true, {
      skill: {
        name: record.name,
        provider: record.provider,
        description: record.description,
        vaultPath: record.vaultPath,
        instructions,
        structure,
      },
      nudge: 'Skill folder structure is in `skill.structure` (paths relative to the skill folder; ' +
        'folders end with `/`). Use your normal `content read` tool — prefixing paths with ' +
        '`skill.vaultPath` — to open any bundled file. Pass `recursive: true` for the full file tree.',
      alternatives: matches.slice(1).map((m) => ({
        name: m.name,
        provider: m.provider,
        lastLoadedAt: m.lastLoadedAt,
      })),
      ...(usageHistory ? { usageHistory } : {}),
    });
  }

  /**
   * Build a loadWorkspace-shaped folder structure for the skill folder, read via
   * `vault.adapter` (so it sees the same dot/hidden-safe tree the scanner walks).
   *
   * - top-level (default): item basenames, folders marked with a trailing `/`.
   * - recursive: flat, sorted relative file paths (folders are descended into,
   *   not listed) — matching WorkspaceFileCollector's recursive output.
   *
   * `_`/`.`-prefixed entries (e.g. co-located `_archive/` sync snapshots) are
   * excluded at every level, consistent with the scanner. Best-effort: any
   * adapter failure yields `[]` rather than failing the load.
   */
  private async buildStructure(
    adapter: DataAdapter,
    root: string,
    recursive: boolean
  ): Promise<string[]> {
    const isIgnored = (base: string): boolean => base.startsWith('_') || base.startsWith('.');
    try {
      if (recursive) {
        const out: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          const listing = await adapter.list(dir);
          for (const file of listing.files) {
            out.push(file.replace(`${root}/`, ''));
          }
          for (const folder of listing.folders) {
            if (isIgnored(LoadSkillTool.basename(folder))) {
              continue;
            }
            await walk(folder);
          }
        };
        await walk(root);
        return out.sort();
      }

      const listing = await adapter.list(root);
      const folders = listing.folders
        .map((f) => LoadSkillTool.basename(f))
        .filter((base) => !isIgnored(base))
        .map((base) => `${base}/`);
      const files = listing.files.map((f) => LoadSkillTool.basename(f));
      return [...folders, ...files].sort();
    } catch {
      return [];
    }
  }

  /** Basename of a vault-relative path (handles trailing slash). */
  private static basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (folder name) to load.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id. Required only when the name is ambiguous across providers.',
        },
        recursive: {
          type: 'boolean',
          description: 'Show the full recursive file tree (true) or top-level items only (false). ' +
            'Default: false (top-level only, folders marked with a trailing /).',
          default: false,
        },
        includeHistory: {
          type: 'boolean',
          description: 'If true, include recent usage history with this skill. Default: true',
        },
      },
      required: ['name'],
    });
  }
}
