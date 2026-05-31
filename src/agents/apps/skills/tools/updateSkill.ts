/**
 * UpdateSkillTool — CRUA update tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/updateSkill.ts
 * Updates an existing skill's frontmatter/body (all but name optional), archives
 * the prior version into the skill's own _archive/<ts>/ before overwriting, and
 * syncs back to the origin dotfolder when origin_path is set (§3). Validated (§7).
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface UpdateSkillParams extends CommonParameters {
  name: string;
  source?: string;
  description?: string;
  body?: string;
  rename?: string;
}

export class UpdateSkillTool extends BaseTool<UpdateSkillParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'updateSkill',
      'Update Skill',
      'Update an existing skill\'s description and/or body, optionally renaming it. ' +
      'Validated before writing; archives the prior version and syncs back to the origin if provider-sourced.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: UpdateSkillParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills updateSkill: not yet implemented (foundation phase)');
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill to update.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id to disambiguate when the name exists across providers.',
        },
        description: {
          type: 'string',
          description: 'Optional new description. Validated for non-empty and sane length.',
        },
        body: {
          type: 'string',
          description: 'Optional new SKILL.md body.',
        },
        rename: {
          type: 'string',
          description: 'Optional new name — lowercase-hyphenated. Renames the skill folder.',
        },
      },
      required: ['name'],
    });
  }
}
