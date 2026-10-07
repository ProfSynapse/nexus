import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

interface SyncSkillsParams extends CommonParameters {
  direction?: 'import' | 'sync-back' | 'both';
  source?: string;
}

export class SyncSkillsTool extends BaseTool<SyncSkillsParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'syncSkills',
      'Sync Skills',
      'Import provider skills into the vault mirror and/or sync edited skills back to their origin ' +
      'dotfolders. Providers are auto-discovered from the vault-root scan. Cross-platform via vault.adapter.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: SyncSkillsParams): Promise<CommonResult> {
    const result = await this.agent.skillService.sync(params);
    return result.ok ? this.prepareResult(true, result.value) : this.prepareResult(false, undefined, result.error.message);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['import', 'sync-back', 'both'],
          description: '"import" provider → mirror, "sync-back" mirror → provider, or "both". Default: "both"',
        },
        source: {
          type: 'string',
          description: 'Optional provider id to sync. Omit to sync every discovered provider.',
        },
      },
      required: [],
    });
  }
}
