import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

interface UpdateSkillParams extends CommonParameters {
  repairReferencesFrom?: import('../../../services/instructions/types').SkillReference;
  name: string;
  frontmatter?: Record<string, unknown>;
  toolSelectors?: string[];
  source?: string;
  description?: string;
  body?: string;
  rename?: string;
}

export class UpdateSkillTool extends BaseTool<UpdateSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'updateSkill',
      'Update Skill',
      'Update an existing skill\'s description and/or body, optionally renaming it. ' +
      'Validated before writing; archives the prior version and syncs back to the origin if provider-sourced.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: UpdateSkillParams): Promise<CommonResult> {
    const resolved = await this.agent.skillService.resolveForMutation(params.name, params.source);
    if (!resolved.ok) return this.prepareResult(false, undefined, resolved.error.message);
    const result = await this.agent.skillService.update(resolved.value, params);
    if (!result.ok) {
      const repair = result.error.repairReferencesFrom;
      const current = result.error.reference;
      const message = repair && current?.type === 'skill'
        ? `${result.error.message}. Skill is now ${current.provider}/${current.name}; retry skills update-skill using name ${current.name} and source ${current.provider}, with --repair-references-from set to ${JSON.stringify(repair)}.`
        : result.error.message;
      return this.prepareResult(false, current ? { reference: current, ...(repair ? { repairReferencesFrom: repair } : {}) } : undefined, message);
    }
    return this.prepareResult(true, { skill: {
      name: result.value.name, provider: result.value.reference.provider,
      description: result.value.description, vaultPath: result.value.resourceRoot,
    }, ...('syncBackError' in result.value ? { syncBackError: result.value.syncBackError } : {}),
      ...('syncedBackTo' in result.value ? { syncedBackTo: result.value.syncedBackTo } : {}),
      ...(result.value.previousReference ? { previousReference: result.value.previousReference } : {}) });
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        repairReferencesFrom: { type: 'object', properties: { provider: { type: 'string' }, name: { type: 'string' } }, required: ['provider', 'name'], additionalProperties: false,
          description: 'Explicit prior qualified identity returned by a partial rename failure. Target the returned new name/source and pass this field to retry updating workflow attachments.' },
        frontmatter: { type: 'object', additionalProperties: true, description: 'Optional frontmatter metadata; existing keys are preserved on update.' },
        toolSelectors: { type: 'array', items: { type: 'string' }, description: 'Required Nexus tool selectors. An explicit empty array clears dependencies.' },
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
