/**
 * ListSkillsTool — discovery tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/listSkills.ts
 * Scans the in-vault mirror, syncs the SQLite index, and returns discovered
 * skills ordered by last_loaded_at (most-recent first). Optionally filtered by
 * search query, provider source, or archived state.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime } from '../services/SkillsContext';

interface ListSkillsParams extends CommonParameters {
  search?: string;
  source?: string;
  includeArchived?: boolean;
}

export class ListSkillsTool extends BaseTool<ListSkillsParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'listSkills',
      'List Skills',
      'List discovered skills, recency-ordered, with name/provider/description. ' +
      'Optionally filter by search query, provider source, or include archived skills.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ListSkillsParams): Promise<CommonResult> {
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    const parsed = await r.rt.scanner.scan();
    await r.rt.index.syncFromScan(parsed);

    let skills = await r.rt.index.list({
      search: params.search,
      includeArchived: params.includeArchived,
    });

    // Provider filter is applied in JS — `source` targets the first path segment.
    if (params.source) {
      skills = skills.filter((s) => s.provider === params.source);
    }

    return this.prepareResult(true, {
      count: skills.length,
      skills: skills.map((s) => ({
        name: s.name,
        provider: s.provider,
        description: s.description,
        isArchived: s.isArchived,
        lastLoadedAt: s.lastLoadedAt,
        vaultPath: s.vaultPath,
      })),
    });
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Optional case-insensitive query matched against skill name/description.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id (e.g. "claude", "codex", "nexus") to filter by source.',
        },
        includeArchived: {
          type: 'boolean',
          description: 'If true, include archived skills in the result. Default: false',
        },
      },
      required: [],
    });
  }
}
