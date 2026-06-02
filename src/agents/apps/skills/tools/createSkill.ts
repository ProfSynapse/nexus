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
import { hashSkillContent } from '../services/skillHash';
import { assertInside, SkillPathError } from '../services/skillPaths';

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

    const validator = new SkillValidator();

    // Validate the frontmatter input before touching disk (§7).
    const validation = validator.validate({
      name: params.name,
      description: params.description,
      body: params.body,
    });
    if (!validation.valid) {
      return this.prepareResult(false, { validationErrors: validation.errors }, 'Skill validation failed');
    }

    const provider = params.source ?? 'nexus';

    // Validate the provider/source id with the SAME lowercase-hyphenated rule as
    // `name` so a model-supplied `source` can never inject path traversal — it is
    // a higher path segment than the (already-validated) name.
    const providerValidation = validator.validateProvider(provider);
    if (!providerValidation.valid) {
      return this.prepareResult(false, { validationErrors: providerValidation.errors }, 'Skill validation failed');
    }

    const folder = normalizePath(`${r.rt.skillsRoot}/${provider}/${params.name}`);

    // Defense in depth: the assembled path must resolve inside the skills root.
    try {
      assertInside(r.rt.skillsRoot, folder);
    } catch (e) {
      const message = e instanceof SkillPathError ? e.message : 'Invalid skill path';
      return this.prepareResult(false, undefined, message);
    }

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
      contentHash: hashSkillContent(skillMd),
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
