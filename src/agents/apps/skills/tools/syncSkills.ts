/**
 * SyncSkillsTool — import + sync-back tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/syncSkills.ts
 * Imports provider skills (<vault>/.<provider>/skills → <root>/skills/<provider>)
 * and syncs edited mirror copies back to their origin dotfolders, all via
 * vault.adapter (cross-platform). Archive-then-replace, last-writer-wins (§3).
 * Providers are auto-discovered from the vault-root provider-dotfolder scan.
 * See: docs/plans/skills-protocol-integration-plan.md §3 / §12.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime } from '../services/SkillsContext';
import { SkillSyncService } from '../services/SkillSyncService';

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
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    const direction = params.direction ?? 'both';
    const sync = new SkillSyncService(r.rt.vaultAdapter, r.rt.skillsRoot, r.rt.index);

    const providers = await sync.discoverProviders();
    const wantsImport = direction === 'import' || direction === 'both';
    const wantsSyncBack = direction === 'sync-back' || direction === 'both';

    // No provider dotfolders found and we'd be importing → §12 empty shape.
    if (providers.length === 0 && wantsImport) {
      return this.prepareResult(true, {
        providers: [],
        imported: [],
        syncedBack: [],
        skipped: [],
        note: 'No .{provider}/skills folders found at the vault root.',
      });
    }

    const imported: string[] = [];
    const syncedBack: string[] = [];
    const skipped: string[] = [];
    const archived: string[] = [];

    if (wantsImport) {
      const res = await sync.import(params.source);
      imported.push(...res.imported);
      skipped.push(...res.skipped);
      archived.push(...res.archived);
    }

    if (wantsSyncBack) {
      const res = await sync.syncBack(params.source);
      syncedBack.push(...res.syncedBack);
      skipped.push(...res.skipped);
      archived.push(...res.archived);
    }

    return this.prepareResult(true, {
      providers,
      imported,
      syncedBack,
      skipped,
      archived,
    });
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
