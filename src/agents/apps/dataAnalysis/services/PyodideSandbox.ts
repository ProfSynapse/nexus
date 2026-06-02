/**
 * PyodideSandbox — runs Python (pandas) in a locked-down Web Worker.
 *
 * Isolation (plan §4): dedicated Worker with no Node integration, MEMFS-only FS,
 * the network surface scrubbed after load (see pyodideWorkerSource), and runaway
 * code killed deterministically by worker.terminate(). Desktop-only.
 *
 * Runs are SERIALIZED: Pyodide's runPythonAsync is not reentrant and the worker
 * is reused, so a queue guarantees one analysis at a time. A timeout terminates
 * the worker and rejects the in-flight run; queued runs re-bootstrap on their turn.
 *
 * Loading (validated in a real Obsidian desktop build): a Blob worker hides Node
 * globals (so Pyodide uses its web loader), importScripts + loadPyodide read the
 * vendored runtime from an app:// indexURL (file:// is blocked in Electron
 * workers), and micropip wheels install offline via the emfs: scheme. The
 * data-flow, marshalling, and network-scrub mechanics were validated in the
 * Phase 0 spike (docs/plans/spike-findings-pyodide-2026-05-31.md).
 */

import { App } from 'obsidian';
import {
  IAnalysisSandbox,
  SandboxRunRequest,
  SandboxRunResult,
  PYODIDE_PACKAGES,
} from '../types';
import { resolvePyodideAssets, pyodideAssetsPresent, resolvePyodideDirVaultPath } from './PyodideAssets';
import { buildPyodideWorkerSource } from './pyodideWorkerSource';
import { PyodideEnsurer } from './PyodideEnsurer';

interface WorkerMessage {
  type?: string;
  id?: number;
  success?: boolean;
  data?: unknown;
  logs?: string[];
  error?: string;
  stats?: { durationMs: number };
}

export class PyodideSandbox implements IAnalysisSandbox {
  private readonly app: App;
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private blobUrl: string | null = null;
  private seq = 0;
  /** Tail of the run queue — serializes runs over the single reused worker. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(app: App) {
    this.app = app;
  }

  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.bootstrap().catch((err) => {
        // allow a later retry to re-bootstrap
        this.readyPromise = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async bootstrap(): Promise<void> {
    // First use / partial install: the ensurer is idempotent and per-file, so
    // run it unconditionally to recover from an interrupted prior download.
    const targetDir = await resolvePyodideDirVaultPath(this.app);
    const ensured = await new PyodideEnsurer(this.app).ensureAssets(targetDir);
    if (!ensured.ok || !(await pyodideAssetsPresent(this.app))) {
      throw new Error(
        `The Python data environment could not be installed${ensured.error ? `: ${ensured.error}` : ''}. ` +
          'Check your internet connection and try again.'
      );
    }

    const assets = await resolvePyodideAssets(this.app);
    const source = buildPyodideWorkerSource({
      indexUrl: assets.indexUrl,
      loadPackages: [...PYODIDE_PACKAGES],
      micropipWheels: assets.micropipWheels,
    });

    this.blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    const worker = new Worker(this.blobUrl);
    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        done = true;
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        this.revokeBlobUrl();
      };
      const onMsg = (ev: MessageEvent<WorkerMessage>) => {
        const d = ev.data || {};
        if (d.type === 'ready') {
          cleanup();
          resolve();
        } else if (d.type === 'init-error') {
          cleanup();
          reject(new Error(d.error || 'Pyodide failed to initialize.'));
        }
      };
      const onErr = (e: ErrorEvent) => {
        if (done) return;
        cleanup();
        reject(new Error(`Sandbox worker error: ${e.message}`));
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ type: 'init' });
    });
  }

  run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    // Chain onto the queue so only one run executes at a time, regardless of
    // whether the previous one resolved or rejected.
    const turn = this.tail.then(
      () => this.execOne(request),
      () => this.execOne(request)
    );
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async execOne(request: SandboxRunRequest): Promise<SandboxRunResult> {
    try {
      await this.ensureReady();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const worker = this.worker;
    if (!worker) {
      return { success: false, error: 'Sandbox worker is not available.' };
    }
    const id = ++this.seq;

    return new Promise<SandboxRunResult>((resolve) => {
      let settled = false;
      const finish = (r: SandboxRunResult) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        resolve(r);
      };

      const onMsg = (ev: MessageEvent<WorkerMessage>) => {
        const d = ev.data || {};
        if (d.type === 'result' && d.id === id) {
          finish({ success: !!d.success, data: d.data, logs: d.logs, error: d.error, stats: d.stats });
        }
      };

      const timer = window.setTimeout(() => {
        // runaway code: terminating the worker is the only deterministic stop.
        // Safe because runs are serialized — no other run is using this worker.
        this.hardReset();
        finish({
          success: false,
          error: `Analysis exceeded ${request.timeoutMs}ms and was terminated. Reduce the work or add a limit.`,
        });
      }, request.timeoutMs);

      worker.addEventListener('message', onMsg);
      worker.postMessage(
        {
          type: 'run',
          id,
          code: request.code,
          files: request.files.map((f) => ({
            varName: f.varName,
            sandboxPath: f.sandboxPath,
            bytes: f.bytes,
          })),
        },
        request.files.map((f) => f.bytes.buffer)
      );
    });
  }

  private revokeBlobUrl(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }

  private hardReset(): void {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.revokeBlobUrl();
  }

  dispose(): void {
    this.hardReset();
  }
}
