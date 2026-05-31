/**
 * RunAnalysisTool — execute Python (pandas) against vault CSV/Excel data in a
 * sandboxed, network-isolated Pyodide worker.
 *
 * Trusted-host responsibilities (the guest does none of this):
 *   - desktop gate, parameter validation
 *   - read input files from the vault (path-jailed via isValidPath) and enforce
 *     the input-size cap
 *   - run the code in the sandbox with a wall-clock timeout
 *   - enforce the output row cap and optionally persist the result to the vault
 */

import { normalizePath } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { isDesktop } from '../../../../utils/platform';
import { isValidPath } from '../../../../utils/pathUtils';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs } from '../../../utils/toolStatusLabels';
import { DataAnalysisAgent } from '../DataAnalysisAgent';
import { dataToCsv } from '../spreadsheet/csv';
import { RunAnalysisParams, SandboxFile } from '../types';
import {
  clampInputBytes,
  clampMaxRows,
  clampOutputBytes,
  clampTimeout,
  enforceOutputBudget,
  enforceRowCap,
  formatBytesMb,
  sandboxFileName,
  validateInputPath,
} from '../services/guards';

export class RunAnalysisTool extends BaseTool<RunAnalysisParams, CommonResult> {
  private agent: DataAnalysisAgent;

  constructor(agent: DataAnalysisAgent) {
    super(
      'runAnalysis',
      'Run Analysis',
      'Run Python (pandas) against vault CSV/Excel files in an isolated runtime ' +
        '(off-thread, no Node, in-memory filesystem), returning a bounded result. Provide `code` ' +
        'and optional `inputs` (a map of ' +
        "variable name -> vault path); read them in Python via `inputs['name']`, e.g. " +
        "`pd.read_csv(inputs['budget'])` or `pd.read_excel(inputs['sales'])`. Return a " +
        'JSON-serializable value (results over 1500 rows are rejected — aggregate or limit). ' +
        'Desktop only. Isolation is best-effort (blocks accidental network/vault access), not a ' +
        'hard sandbox for untrusted code.',
      '0.1.0'
    );
    this.agent = agent;
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return verbs('Analyzing data', 'Analyzed data', 'Analysis failed')[tense];
  }

  async execute(params: RunAnalysisParams): Promise<CommonResult> {
    if (!isDesktop()) {
      return this.prepareResult(false, undefined, 'Data Analysis is desktop-only.');
    }

    const code = params.code;
    if (typeof code !== 'string' || !code.trim()) {
      return this.prepareResult(false, undefined, 'Missing "code" — provide Python to run.');
    }

    const vault = this.agent.getVault();
    if (!vault) {
      return this.prepareResult(false, undefined, 'Vault not available.');
    }

    const maxRows = clampMaxRows(params.maxRows);
    const maxOutputBytes = clampOutputBytes(params.maxOutputBytes);
    const maxInputBytes = clampInputBytes(params.maxInputBytes);
    const timeoutMs = clampTimeout(params.timeoutMs);

    // Validate the output path up front, before doing any work.
    if (params.outputPath !== undefined && !isValidPath(params.outputPath)) {
      return this.prepareResult(false, undefined,
        `Invalid output path: "${params.outputPath}" — must be vault-relative, no ".." or absolute paths`);
    }

    // Gather + size-cap input files (trusted host reads; guest never sees the vault).
    // Each file gets an index-prefixed path so two vars that sanitize to the same
    // name can't collide and silently overwrite each other on disk.
    const files: SandboxFile[] = [];
    const inputEntries = Object.entries(params.inputs ?? {});
    for (let i = 0; i < inputEntries.length; i++) {
      const [varName, inputPath] = inputEntries[i];
      const check = validateInputPath(inputPath);
      if (!check.ok) {
        return this.prepareResult(false, undefined, check.error);
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await vault.adapter.readBinary(normalizePath(inputPath));
      } catch {
        return this.prepareResult(false, undefined, `Input not found or unreadable: "${inputPath}"`);
      }
      if (buffer.byteLength > maxInputBytes) {
        return this.prepareResult(false, undefined,
          `Input "${inputPath}" is ${formatBytesMb(buffer.byteLength)}MB (max ` +
          `${formatBytesMb(maxInputBytes)}MB). Pre-filter the file and retry.`);
      }
      files.push({
        varName,
        sandboxPath: `/data/${i}_${sandboxFileName(varName, inputPath)}`,
        bytes: new Uint8Array(buffer),
      });
    }

    // Run in the sandbox.
    let result;
    try {
      const sandbox = await this.agent.getSandbox();
      result = await sandbox.run({ code, files, timeoutMs });
    } catch (error) {
      return this.prepareResult(false, undefined,
        `Failed to run analysis: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!result.success) {
      return this.prepareResult(false, undefined, result.error ?? 'Analysis failed.');
    }

    // Enforce the output row cap (top-level arrays) and the universal byte
    // backstop (any shape, so a {rows:[...]} / to_dict() can't bypass the cap).
    const cap = enforceRowCap(result.data, maxRows);
    if (!cap.ok) {
      return this.prepareResult(false, undefined, cap.error);
    }
    const budget = enforceOutputBudget(result.data, maxOutputBytes);
    if (!budget.ok) {
      return this.prepareResult(false, undefined, budget.error);
    }

    // Optionally persist the result.
    let writtenPath: string | undefined;
    if (params.outputPath) {
      const outPath = normalizePath(params.outputPath);
      try {
        await this.writeResult(vault, outPath, result.data);
        writtenPath = outPath;
      } catch (error) {
        return this.prepareResult(false, undefined,
          `Computed the result but failed to write "${outPath}": ` +
          `${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return this.prepareResult(true, {
      result: result.data,
      rows: cap.rowCount,
      logs: result.logs ?? [],
      stats: result.stats,
      ...(writtenPath ? { outputPath: writtenPath } : {}),
    });
  }

  private async writeResult(
    vault: NonNullable<ReturnType<DataAnalysisAgent['getVault']>>,
    outPath: string,
    data: unknown
  ): Promise<void> {
    // A `.csv` outputPath writes tabular CSV (so pandas results can land in a
    // spreadsheet mirror shard, auto-syncing back to .xlsx); anything else is JSON.
    const content = /\.csv$/i.test(outPath) ? dataToCsv(data) : JSON.stringify(data, null, 2);
    const existing = vault.getAbstractFileByPath(outPath);
    if (existing) {
      await vault.adapter.write(outPath, content);
    } else {
      const dir = outPath.includes('/') ? outPath.slice(0, outPath.lastIndexOf('/')) : '';
      if (dir && !vault.getAbstractFileByPath(dir)) {
        await vault.createFolder(dir).catch(() => undefined);
      }
      await vault.create(outPath, content);
    }
  }

  getParameterSchema(): JSONSchema {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            "Python source to execute. Read inputs via the injected `inputs` dict, e.g. " +
            "`pd.read_csv(inputs['budget'])`. The final expression / returned value is sent back " +
            '(must be JSON-serializable; results over maxRows are rejected).',
        },
        inputs: {
          type: 'object',
          description:
            'Map of variable name -> vault-relative file path (.csv/.xlsx). Each file is read by ' +
            "the host and exposed to Python as inputs['name'].",
          additionalProperties: { type: 'string' },
        },
        maxRows: {
          type: 'number',
          description: 'Reject results with more than this many rows (default 1500, hard max 10000).',
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Reject results whose serialized JSON exceeds this many bytes (default ~512KB).',
        },
        maxInputBytes: {
          type: 'number',
          description: 'Reject input files larger than this many bytes (default ~10MB).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Wall-clock budget; runaway code is terminated (default 5000, hard max 30000).',
        },
        outputPath: {
          type: 'string',
          description: 'Optional vault path to write the result JSON to after a successful run.',
        },
      },
      required: ['code'],
    };
    return this.getMergedSchema(schema);
  }
}
