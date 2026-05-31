/**
 * CreateSkillTool — CRUA create tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/createSkill.ts
 * Creates <root>/skills/<provider>/<name>/SKILL.md from name+description+body,
 * validated through the SkillValidator (§7). Defaults to the vault-native
 * 'nexus' provider when no source is given.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { normalizePath } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime } from '../services/SkillsContext';
import { SkillWriteService } from '../services/SkillWriteService';
import { SkillValidator } from '../services/SkillValidator';
import { fnv1aHex } from '../services/skillHash';

interface CreateSkillParams extends CommonParameters {
  name: string;
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
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    // Validate the frontmatter input before touching disk (§7).
    const validation = new SkillValidator().validate({
      name: params.name,
      description: params.description,
      body: params.body,
    });
    if (!validation.valid) {
      return this.prepareResult(false, { validationErrors: validation.errors }, 'Skill validation failed');
    }

    const provider = params.source ?? 'nexus';
    const folder = normalizePath(`${r.rt.skillsRoot}/${provider}/${params.name}`);

    const write = new SkillWriteService(r.rt.vaultAdapter);
    if (await write.exists(folder)) {
      return this.prepareResult(false, undefined, `Skill already exists: ${provider}/${params.name}`);
    }

    const skillMd = await write.composeSkillMd(params.name, params.description, params.body);
    await write.writeSkill(folder, skillMd);

    await r.rt.index.upsertOne({
      provider,
      name: params.name,
      description: params.description,
      vaultPath: folder,
      contentHash: fnv1aHex(skillMd),
    });

    return this.prepareResult(true, {
      skill: {
        name: params.name,
        provider,
        description: params.description,
        vaultPath: folder,
      },
      created: `${folder}/SKILL.md`,
    });
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
