/**
 * MirrorWorkbookTool — project an `.xlsx`/`.xlsm` into editable, sharded CSV
 * files under `<root>/spreadsheets/<workbookId>/` (the AI's value surface). The
 * original workbook stays the source of truth (formulas/charts/formatting); the
 * CSVs are a regenerated projection. Idempotent — re-mirroring an unchanged file
 * is a no-op. Desktop-only (uses the vendored hucre engine).
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
import { WorkbookMirrorService } from '../spreadsheet/WorkbookMirrorService';
import { workbookIdFromPath } from '../spreadsheet/workbookId';

export interface MirrorWorkbookParams extends CommonParameters {
  /** Vault-relative path to the source `.xlsx`/`.xlsm`. */
  path: string;
}

export class MirrorWorkbookTool extends BaseTool<MirrorWorkbookParams, CommonResult> {
  private agent: DataAnalysisAgent;

  constructor(agent: DataAnalysisAgent) {
    super(
      'mirrorWorkbook',
      'Mirror Workbook',
      'Project an Excel workbook (.xlsx/.xlsm) into editable CSV shards under ' +
        '<root>/spreadsheets/<id>/ — one CSV per sheet (sharded by size), plus a manifest. ' +
        'Edit those CSVs, then call applyToWorkbook to write changes back losslessly. ' +
        'Idempotent. Desktop only.',
      '0.1.0'
    );
    this.agent = agent;
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return verbs('Mirroring workbook', 'Mirrored workbook', 'Mirror failed')[tense];
  }

  async execute(params: MirrorWorkbookParams): Promise<CommonResult> {
    if (!isDesktop()) {
      return this.prepareResult(false, undefined, 'Spreadsheet mirroring is desktop-only.');
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
      const workbook = await source.readWorkbook(new Uint8Array(buffer));

      const { root, maxShardBytes } = this.agent.getMirrorStorage();
      const workbookId = workbookIdFromPath(params.path);
      const mirror = new WorkbookMirrorService(vault.adapter);
      const { manifest, regenerated } = await mirror.generate(workbook, { root, workbookId, maxShardBytes });

      return this.prepareResult(true, {
        mirrorDir: mirror.mirrorDir({ root, workbookId, maxShardBytes }),
        regenerated,
        hasMacros: manifest.hasMacros,
        sheets: manifest.sheets.map((s) => ({
          name: s.name,
          rows: s.rowCount,
          cols: s.colCount,
          shards: s.shards.map((sh) => sh.file),
          formulaCells: s.formulaCells.length,
        })),
      });
    } catch (error) {
      return this.prepareResult(false, undefined,
        `Failed to mirror workbook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getParameterSchema(): JSONSchema {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the .xlsx/.xlsm workbook (no leading slash).' },
      },
      required: ['path'],
      description: 'Project a workbook into editable CSV shards under <root>/spreadsheets/<id>/.',
    };
    return this.getMergedSchema(schema as JSONSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        mirrorDir: { type: 'string' },
        regenerated: { type: 'boolean' },
        hasMacros: { type: 'boolean' },
        sheets: { type: 'array' },
        error: { type: 'string' },
      },
      required: ['success'],
    };
  }
}
