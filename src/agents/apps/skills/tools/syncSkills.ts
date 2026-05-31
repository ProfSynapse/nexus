/**
 * SyncSkillsTool — import + sync-back tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/syncSkills.ts
 * Imports provider skills (<vault>/.<provider>/skills → <root>/skills/<provider>)
 * and syncs edited mirror copies back to their origin dotfolders, all via
 * vault.adapter (cross-platform). Archive-then-replace, last-writer-wins (§3).
 * Providers are auto-discovered from the vault-root provider-dotfolder scan.
 * Foundation-phase stub — wiring lands in a later wave.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';

interface SyncSkillsParams extends CommonParameters {
  direction?: 'import' | 'sync-back' | 'both';
  source?: string;
}

export class SyncSkillsTool extends BaseTool<SyncSkillsParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'syncSkills',
      'Sync Skills',
      'Import provider skills into the vault mirror and/or sync edited skills back to their origin ' +
      'dotfolders. Providers are auto-discovered from the vault-root scan. Cross-platform via vault.adapter.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(_params: SyncSkillsParams): Promise<CommonResult> {
    await Promise.resolve(); // TODO(foundation): replace with real async work
    return this.prepareResult(false, undefined,
      'Skills syncSkills: not yet implemented (foundation phase)');
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
