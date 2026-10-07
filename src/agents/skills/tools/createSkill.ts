import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

interface CreateSkillParams extends CommonParameters {
  name: string;
  frontmatter?: Record<string, unknown>;
  toolSelectors?: string[];
  description: string;
  body: string;
  source?: string;
}

export class CreateSkillTool extends BaseTool<CreateSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'createSkill',
      'Create Skill',
      'Create a new skill from name/description/body. Validated before writing. ' +
      'Defaults to the vault-native "nexus" provider when no source is given.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: CreateSkillParams): Promise<CommonResult> {
    const result = await this.agent.skillService.create(params);
    return result.ok ? this.prepareResult(true, { skill: {
      name: result.value.name, provider: result.value.reference.provider,
      description: result.value.description, vaultPath: result.value.resourceRoot,
    }, created: result.value.entrypointPath }) : this.prepareResult(false, undefined, result.error.message);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        frontmatter: { type: 'object', additionalProperties: true, description: 'Optional frontmatter metadata; existing keys are preserved on update.' },
        toolSelectors: { type: 'array', items: { type: 'string' }, description: 'Required Nexus tool selectors. An explicit empty array clears dependencies.' },
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
