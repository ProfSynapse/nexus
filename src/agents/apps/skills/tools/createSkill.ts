/**
 * CreateSkillTool — CRUA create tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/createSkill.ts
 * Creates <root>/skills/<provider>/<name>/SKILL.md from name+description+body,
 * validated through the SkillValidator (§7). Defaults to the vault-native
 * 'nexus' provider when no source is given.
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface CreateSkillParams extends CommonParameters {
  name: string;
  description: string;
  body: string;
  source?: string;
}

export class CreateSkillTool extends BaseTool<CreateSkillParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'createSkill',
      'Create Skill',
      'Create a new skill from name/description/body. Validated before writing. ' +
      'Defaults to the vault-native "nexus" provider when no source is given.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: CreateSkillParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills createSkill: not yet implemented (foundation phase)');
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name — lowercase-hyphenated; becomes the folder name. Must be unique within the provider.',
        },
        description: {
          type: 'string',
          description: 'Skill description — the discovery signal surfaced in listSkills. Non-empty, sane length.',
        },
        body: {
          type: 'string',
          description: 'SKILL.md body — the playbook the agent reads back and follows.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id. Default: "nexus" (vault-native).',
        },
      },
      required: ['name', 'description', 'body'],
    });
  }
}
