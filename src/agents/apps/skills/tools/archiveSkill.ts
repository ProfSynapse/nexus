/**
 * ArchiveSkillTool — CRUA archive tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/archiveSkill.ts
 * Sets (or, with restore, clears) the skill's is_archived flag — the model's
 * only "delete" (soft, reversible). Hard delete is UI-only, mirroring the state
 * CRUA contract (#215). This is the §7 WHOLE-SKILL soft-delete; it does NOT move
 * or delete the folder (distinct from the §3 version-archive).
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime, resolveSkillByName } from '../services/SkillsContext';

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
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    // Resolve the target provider (source/ambiguity handling shared with updateSkill).
    const resolved = await resolveSkillByName(r.rt.index, params.name, params.source);
    if (!resolved.ok) {
      return this.prepareResult(false, undefined, resolved.error);
    }

    const rec = await r.rt.index.setArchived(
      resolved.record.provider,
      resolved.record.name,
      !params.restore
    );
    if (!rec) {
      return this.prepareResult(false, undefined, `No skill named "${params.name}"`);
    }

    return this.prepareResult(true, {
      name: rec.name,
      provider: rec.provider,
      isArchived: rec.isArchived,
    });
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
