/**
 * ArchiveSkillTool — CRUA archive tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/archiveSkill.ts
 * Sets (or, with restore, clears) the skill's is_archived flag — the model's
 * only "delete" (soft, reversible). Hard delete is UI-only, mirroring the state
 * CRUA contract (#215).
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface ArchiveSkillParams extends CommonParameters {
  name: string;
  source?: string;
  restore?: boolean;
}

export class ArchiveSkillTool extends BaseTool<ArchiveSkillParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'archiveSkill',
      'Archive Skill',
      'Archive a skill (soft, reversible) so it is hidden from listSkills, or restore an archived skill. ' +
      'This is the only "delete" available to the model; hard delete is UI-only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: ArchiveSkillParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills archiveSkill: not yet implemented (foundation phase)');
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
