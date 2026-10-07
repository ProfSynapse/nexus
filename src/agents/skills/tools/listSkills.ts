import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

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
    const result = await this.agent.skillService.list(params);
    return result.ok ? this.prepareResult(true, {
      count: result.value.length,
      skills: result.value.map(r => ({ name: r.name, provider: r.provider, description: r.description,
        isArchived: r.isArchived, lastLoadedAt: r.lastLoadedAt, vaultPath: r.vaultPath })),
    }) : this.prepareResult(false, undefined, result.error.message);
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
