/**
 * LoadSkillTool — activation tool for the Skills app (loadWorkspace-shaped).
 *
 * Located at: src/agents/apps/skills/tools/loadSkill.ts
 * Returns the SKILL.md body, the skill folder listing, a nudge to read bundled
 * files with the existing `content read` tool, and recent usage history (§9).
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface LoadSkillParams extends CommonParameters {
  name: string;
  source?: string;
  includeHistory?: boolean;
}

export class LoadSkillTool extends BaseTool<LoadSkillParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'loadSkill',
      'Load Skill',
      'Load a skill — returns its SKILL.md body, the skill folder listing, a nudge to ' +
      'open bundled files with the existing `content read` tool, and recent usage history. ' +
      'These are instructions to read and follow — do NOT auto-execute them.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: LoadSkillParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills loadSkill: not yet implemented (foundation phase)');
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (folder name) to load.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id. Required only when the name is ambiguous across providers.',
        },
        includeHistory: {
          type: 'boolean',
          description: 'If true, include recent usage history with this skill. Default: true',
        },
      },
      required: ['name'],
    });
  }
}
