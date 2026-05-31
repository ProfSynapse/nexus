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
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime } from '../services/SkillsContext';
import { SkillUsageService, type SkillUsageHistory } from '../services/SkillUsageService';

interface LoadSkillParams extends CommonParameters {
  name: string;
  source?: string;
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

    // List the skill folder's files for navigation.
    let files: string[] = [];
    try {
      const listing = await r.rt.vaultAdapter.list(record.vaultPath);
      files = listing.files;
    } catch {
      // Folder listing is best-effort — a missing listing should not fail the load.
      files = [];
    }

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

    // loadWorkspace-shaped payload (§12): instructions + files nested in `skill`,
    // top-level nudge. `alternatives` surfaces the other recency-ordered matches
    // when a bare name was ambiguous across providers. `usageHistory` is omitted
    // when includeHistory:false or on fetch error.
    return this.prepareResult(true, {
      skill: {
        name: record.name,
        provider: record.provider,
        description: record.description,
        vaultPath: record.vaultPath,
        instructions,
        files: files.map((path) => ({
          path,
          type: path.endsWith('/SKILL.md') ? 'skill' : 'resource',
        })),
      },
      nudge: 'Use your normal `content read` tool to open any of the files listed above.',
      alternatives: matches.slice(1).map((m) => ({
        name: m.name,
        provider: m.provider,
        lastLoadedAt: m.lastLoadedAt,
      })),
      ...(usageHistory ? { usageHistory } : {}),
    });
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
        includeHistory: {
          type: 'boolean',
          description: 'If true, include recent usage history with this skill. Default: true',
        },
      },
      required: ['name'],
    });
  }
}
