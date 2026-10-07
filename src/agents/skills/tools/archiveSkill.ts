import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

interface ArchiveSkillParams extends CommonParameters {
  name: string;
  source?: string;
  restore?: boolean;
}

export class ArchiveSkillTool extends BaseTool<ArchiveSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'archiveSkill',
      'Archive Skill',
      'Archive a skill (soft, reversible) so it is hidden from listSkills, or restore an archived skill. ' +
      'This is the only "delete" available to the model; hard delete is UI-only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ArchiveSkillParams): Promise<CommonResult> {
    const resolved = await this.agent.skillService.resolveForMutation(params.name, params.source);
    if (!resolved.ok) return this.prepareResult(false, undefined, resolved.error.message);
    const result = await this.agent.skillService.archive(resolved.value, !params.restore);
    return result.ok ? this.prepareResult(true, { name: result.value.name, provider: result.value.provider,
      isArchived: result.value.isArchived }) : this.prepareResult(false, undefined, result.error.message);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill to archive or restore.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id to disambiguate when the name exists across providers.',
        },
        restore: {
          type: 'boolean',
          description: 'If true, restore (un-archive) the skill instead of archiving it. Default: false',
        },
      },
      required: ['name'],
    });
  }
}
