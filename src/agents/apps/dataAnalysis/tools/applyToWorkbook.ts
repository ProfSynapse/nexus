/**
 * ApplyToWorkbookTool — write the edited CSV mirror back into the source
 * `.xlsx`/`.xlsm` losslessly: only changed DATA cells are applied (formula cells
 * are guarded), and every untouched part (charts/images/pivots/formatting) is
 * preserved byte-for-byte by the hucre engine. Snapshots the prior CSV shards
 * before writing and re-projects the mirror afterward. Desktop-only.
 *
 * Refuses if the source `.xlsx` changed since the mirror was made (pass
 * `force: true` to override) and supports `dryRun` to preview the change set.
 */

import { normalizePath } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonResult, CommonParameters } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { isDesktop } from '../../../../utils/platform';
import { isValidPath } from '../../../../utils/pathUtils';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs } from '../../../utils/toolStatusLabels';
import { DataAnalysisAgent } from '../DataAnalysisAgent';
import { HucreXlsxSource } from '../spreadsheet/HucreXlsxSource';
import { HucreXlsxWriter } from '../spreadsheet/HucreXlsxWriter';
import { WorkbookMirrorService } from '../spreadsheet/WorkbookMirrorService';
import { WorkbookWriteBackService } from '../spreadsheet/WorkbookWriteBackService';
import { SnapshotArchiveService } from '../../../../services/storage/SnapshotArchiveService';
import { workbookIdFromPath } from '../spreadsheet/workbookId';

export interface ApplyToWorkbookParams extends CommonParameters {
  /** Vault-relative path to the source `.xlsx`/`.xlsm`. */
  path: string;
  /** Preview the change set without writing. */
  dryRun?: boolean;
  /** Proceed even if the source diverged from the mirror. */
  force?: boolean;
}

export class ApplyToWorkbookTool extends BaseTool<ApplyToWorkbookParams, CommonResult> {
  private agent: DataAnalysisAgent;

  constructor(agent: DataAnalysisAgent) {
    super(
      'applyToWorkbook',
      'Apply To Workbook',
      'Write the edited CSV mirror back into the source .xlsx/.xlsm losslessly — only changed ' +
        'data cells are applied (formula cells are never overwritten), and charts/images/pivots/' +
        'formatting are preserved. Snapshots the prior shards and re-projects the mirror. Pass ' +
        'dryRun:true to preview, force:true to override a divergence guard. Desktop only.',
      '0.1.0'
    );
    this.agent = agent;
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return verbs('Applying to workbook', 'Applied to workbook', 'Apply failed')[tense];
  }

  async execute(params: ApplyToWorkbookParams): Promise<CommonResult> {
    if (!isDesktop()) {
      return this.prepareResult(false, undefined, 'Spreadsheet write-back is desktop-only.');
    }
    const vault = this.agent.getVault();
    if (!vault) {
      return this.prepareResult(false, undefined, 'Vault not available.');
    }
    if (!params.path || !isValidPath(params.path)) {
      return this.prepareResult(false, undefined,
        `Invalid path: "${params.path}" — must be vault-relative, no ".." or absolute paths.`);
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await vault.adapter.readBinary(normalizePath(params.path));
    } catch {
      return this.prepareResult(false, undefined, `Workbook not found or unreadable: "${params.path}"`);
    }

    try {
      const mod = await this.agent.getHucreModule();
      const source = new HucreXlsxSource(() => Promise.resolve(mod));
      const writer = new HucreXlsxWriter(() => Promise.resolve(mod));
      const mirror = new WorkbookMirrorService(vault.adapter);
      const snapshot = new SnapshotArchiveService(vault.adapter);
      const writeBack = new WorkbookWriteBackService(vault.adapter, source, writer, mirror, snapshot);

      const { root, maxShardBytes } = this.agent.getMirrorStorage();
      const target = { root, workbookId: workbookIdFromPath(params.path), maxShardBytes };

      const result = await writeBack.apply(target, new Uint8Array(buffer), {
        dryRun: params.dryRun,
        force: params.force,
      });

      if (result.applied && result.newBytes) {
        await vault.adapter.writeBinary(normalizePath(params.path), toArrayBuffer(result.newBytes));
      }

      return this.prepareResult(true, {
        applied: result.applied,
        reason: result.reason,
        archivePath: result.archivePath ?? null,
        summary: result.summary,
      });
    } catch (error) {
      return this.prepareResult(false, undefined,
        `Failed to apply to workbook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getParameterSchema(): JSONSchema {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the .xlsx/.xlsm workbook (no leading slash).' },
        dryRun: { type: 'boolean', description: 'Preview the change set without writing. Default false.' },
        force: { type: 'boolean', description: 'Apply even if the source diverged from the mirror. Default false.' },
      },
      required: ['path'],
      description: 'Write the edited CSV mirror back into the source workbook losslessly.',
    };
    return this.getMergedSchema(schema as JSONSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        applied: { type: 'boolean' },
        reason: { type: 'string' },
        archivePath: { type: ['string', 'null'] },
        summary: { type: 'object' },
        error: { type: 'string' },
      },
      required: ['success'],
    };
  }
}

/** Copy a Uint8Array (possibly a view) into a standalone ArrayBuffer for writeBinary. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
