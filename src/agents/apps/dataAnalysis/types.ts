/**
 * Data Analysis app — shared types.
 *
 * The app runs Python (pandas) against vault CSV/Excel data inside a
 * locked-down Pyodide Web Worker. Data is injected by the trusted host;
 * the guest has no vault, network, or host-filesystem access. Desktop-only.
 */

import { CommonParameters } from '../../../types';

/** Parameters for the `runPython` tool. */
export interface RunPythonParams extends CommonParameters {
  /** Python source. Returns a JSON-serializable value (e.g. df...to_dict('records')). */
  code: string;
  /**
   * Map of variable name -> vault-relative file path. The host reads each file
   * and writes its bytes into the worker FS; a Python global `inputs` maps the
   * same names to in-sandbox paths, so user code does `pd.read_csv(inputs['x'])`.
   */
  inputs?: Record<string, string>;
  /** Reject results with more than this many rows (default 1500). */
  maxRows?: number;
  /** Reject results whose serialized JSON exceeds this many bytes (default 512KB). */
  maxOutputBytes?: number;
  /** Reject input files larger than this many bytes (default 10MB). */
  maxInputBytes?: number;
  /** Wall-clock budget; runaway code is killed by terminating the worker. */
  timeoutMs?: number;
  /** Optional vault path: host writes the result JSON here after a successful run. */
  outputPath?: string;
}

/** A file injected into the sandbox's in-memory FS. */
export interface SandboxFile {
  /** Caller's variable name (key of `inputs`). */
  varName: string;
  /** Absolute path inside the worker MEMFS, e.g. "/data/budget.csv". */
  sandboxPath: string;
  /** Raw file bytes. */
  bytes: Uint8Array;
}

export interface SandboxRunRequest {
  code: string;
  files: SandboxFile[];
  timeoutMs: number;
}

export interface SandboxRunResult {
  success: boolean;
  data?: unknown;
  logs?: string[];
  error?: string;
  stats?: { durationMs: number };
}

/** Sandbox contract — lets the tool be unit-tested with a fake implementation. */
export interface IAnalysisSandbox {
  ensureReady(): Promise<void>;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  dispose(): void;
}

export const DATA_ANALYSIS_DEFAULTS = {
  maxRows: 1500,
  maxRowsHardCap: 10_000,
  maxOutputBytes: 512 * 1024,
  maxOutputBytesHardCap: 4 * 1024 * 1024,
  maxInputBytes: 10 * 1024 * 1024,
  maxInputBytesHardCap: 50 * 1024 * 1024,
  timeoutMs: 5_000,
  timeoutHardCapMs: 30_000,
} as const;

/** Compiled Pyodide packages loaded via loadPackage (pandas pulls numpy + deps). */
export const PYODIDE_PACKAGES = ['pandas'] as const;

/** Packages advertised to callers — derived in one place to avoid drift. */
export const SUPPORTED_PACKAGES = ['pandas', 'numpy', 'openpyxl', 'python-dateutil', 'pytz'] as const;
