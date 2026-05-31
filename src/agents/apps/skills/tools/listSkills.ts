/**
 * ListSkillsTool — discovery tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/listSkills.ts
 * Lists discovered skills, ordered by last_loaded_at (most-recent first).
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface ListSkillsParams extends CommonParameters {
  search?: string;
  source?: string;
  includeArchived?: boolean;
}

export class ListSkillsTool extends BaseTool<ListSkillsParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'listSkills',
      'List Skills',
      'List discovered skills, recency-ordered, with name/provider/description. ' +
      'Optionally filter by search query, provider source, or include archived skills.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: ListSkillsParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills listSkills: not yet implemented (foundation phase)');
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
