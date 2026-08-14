/**
 * BaseQueryRunner — making Obsidian execute a `.base` and hand us the rows.
 *
 * ## Why this is not just "call the query API"
 *
 * There is no query API. `QueryController` is exported with no public members,
 * nothing accepts a `BasesConfigFile` and returns results, and the only
 * supported way to receive a live controller is to have Obsidian render a base
 * using a view type we registered (`basesAvailability.ts`). So the runner makes
 * Obsidian render one, invisibly, and reads the result out of the view.
 *
 * ## The one mechanism that works (Phase 0 spike, Obsidian 1.13.7)
 *
 * Render `![[<scratch>.base#<view>]]` through `MarkdownRenderer.render` into a
 * container that is **attached to the document and positioned off-screen**.
 *
 * A DETACHED container does not work, and never will:
 * `QueryController.runQuery` gates on `viewContainerEl.isShown()`, which is
 * `!!offsetParent`; a detached node has none, so the controller awaits
 * `onNodeInserted` forever. `display: none` fails identically. The view is still
 * constructed and `onload` still fires, which makes this look like a timing
 * problem — it is not, and no amount of waiting fixes it. Anything that
 * preserves a layout box works; `.nexus-base-analyze-host` in styles.css is the
 * off-screen 1×1 box, and it is a class rather than inline styles because the
 * plugin guidelines forbid inline styling.
 *
 * A background leaf was tried and is worse: `setViewState({active:false})`
 * pulled the tab to the front, and a collapsed-sidebar leaf created the view
 * without ever running the query — visible when it works, silent when it does
 * not.
 *
 * ## Why a scratch file rather than editing the user's base
 *
 * Executing a base means rendering a view of type `nexus-analyze`, and that view
 * has to exist in a file. The alternative — inject the view into the user's own
 * `.base`, then restore it in a `finally` — mutates a file the user may have
 * open, fires modify events on it, and leaves a junk view behind if the process
 * dies mid-call. A scratch file is written where the source base lives, exists
 * for ~90 ms, and its worst failure leaves a file that never belonged to anyone
 * and that {@link sweepStaleScratchFiles} removes on the next call.
 *
 * It is a SIBLING of the source base, not a file under the storage root, for
 * two reasons: folder-relative semantics (`this.file.folder`) stay closest to
 * the original, and a storage root can be configured to a dot-folder, which is
 * not in the vault index at all — the embed would then silently resolve to
 * nothing.
 *
 * The scratch file must also be visible for the same reason: a dot-prefixed name
 * is invisible to `app.vault`, so `![[…]]` would not resolve.
 */

import { Component, MarkdownRenderer } from 'obsidian';
import type { App, BasesConfigFile, BasesConfigFileView, BasesView, Plugin } from 'obsidian';
import {
  ANALYZE_PROTOCOL_INERT,
  NEXUS_ANALYZE_VIEW_ID,
  awaitAnalyzeView,
  refreshAnalyzeViewRegistration
} from './basesAvailability';
import { BaseFileOperations, SCRATCH_PREFIX } from './BaseFileOperations';
import { harvestView, HarvestedResult } from './baseResultHarvester';
import { logger } from '../../../utils/logger';

/** Off-screen host class. The rule it satisfies lives in styles.css. */
const HOST_CLASS = 'nexus-base-analyze-host';

/**
 * Ceiling on one render. The spike measured ~85 ms flat regardless of row
 * count, so this is not a performance budget — it is the bound on the failure
 * where `MarkdownRenderer.render` resolves without the view ever producing data
 * (it resolves even when the embedded file does not exist).
 */
export const DEFAULT_ANALYZE_TIMEOUT_MS = 15000;

/** A scratch file older than this cannot belong to an in-flight call. */
const STALE_SCRATCH_MS = 60_000;

export interface AnalyzeRunOptions {
  app: App;
  plugin: Plugin;
  /** Existing, normalised path of the base being analyzed. */
  sourcePath: string;
  config: BasesConfigFile;
  /** View to execute; defaults to the first view in the file. */
  viewName?: string;
  limit: number;
  timeoutMs?: number;
}

export interface AnalyzeRunResult {
  view: { name: string; type: string };
  harvest: HarvestedResult;
  /** Text Obsidian painted around our headless view — empty on a healthy run. */
  renderText: string;
  elapsedMs: number;
}

export class BaseAnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseAnalyzeError';
  }
}

export class BaseQueryRunner {
  /**
   * Pick the view to execute. Matching is case-insensitive because a caller is
   * quoting a name a human wrote; an unmatched name lists what does exist,
   * since "no rows" and "no such view" must never look alike.
   */
  static selectView(config: BasesConfigFile, viewName?: string): BasesConfigFileView {
    const views = Array.isArray(config.views) ? config.views.filter(view => view && typeof view === 'object') : [];
    if (views.length === 0) {
      throw new BaseAnalyzeError('This base declares no views, so there is nothing to execute. Add a view with baseManager.update.');
    }

    if (viewName === undefined || viewName.trim() === '') {
      return views[0];
    }

    const wanted = viewName.trim().toLowerCase();
    const match = views.find(view => typeof view.name === 'string' && view.name.toLowerCase() === wanted);
    if (!match) {
      const available = views.map(view => (typeof view.name === 'string' ? view.name : '(unnamed)')).join(', ');
      throw new BaseAnalyzeError(`View not found: "${viewName}". Views in this base: ${available}`);
    }

    return match;
  }

  /**
   * Execute one view and return its rows.
   *
   * @throws BaseAnalyzeError with an actionable message — the caller renders it
   * into `error`, which on failure is the only field an MCP caller receives.
   */
  static async run(options: AnalyzeRunOptions): Promise<AnalyzeRunResult> {
    const { app, plugin, sourcePath, config, limit } = options;
    const sourceView = this.selectView(config, options.viewName);

    this.assertViewIsUsable(app, plugin);

    const token = this.newToken();
    const scratchViewName = `${NEXUS_ANALYZE_VIEW_ID}-${token}`;
    const scratchPath = this.scratchPathFor(sourcePath, token);
    const scratchConfig = this.buildScratchConfig(config, sourceView, scratchViewName);

    await this.sweepStaleScratchFiles(app);

    const started = Date.now();
    const rendezvous = awaitAnalyzeView(scratchViewName);
    const component = new Component();
    const host = window.activeDocument.body.createDiv({ cls: HOST_CLASS });
    let created = false;

    try {
      await BaseFileOperations.createScratchFile(app, scratchPath, BaseFileOperations.serialize(scratchConfig));
      created = true;

      component.load();

      // sourcePath is the ORIGINAL base, not the scratch copy. This is what
      // makes the scratch copy honest: Obsidian resolves links AND `this`
      // against the source path, so `this.file` is the user's base file rather
      // than our temporary one. [VERIFIED 2026-08-14, Obsidian 1.13.7: a
      // `this.file.name` formula returns the source base's name.] It closes the
      // plan's open question 2 — no in-place-injection fallback is needed.
      await MarkdownRenderer.render(app, `![[${scratchPath}#${scratchViewName}]]`, host, sourcePath, component);

      const view = await this.awaitData(rendezvous.view, options.timeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS, host);

      const harvest = harvestView(view, {
        declaredOrder: Array.isArray(sourceView.order) ? sourceView.order : undefined,
        declaredSummaries: this.asRecord(sourceView.summaries),
        declaredGroupBy: sourceView.groupBy !== undefined && sourceView.groupBy !== null,
        limit,
        excludePath: scratchPath
      });

      return {
        view: { name: typeof sourceView.name === 'string' ? sourceView.name : '(unnamed)', type: typeof sourceView.type === 'string' ? sourceView.type : 'table' },
        harvest,
        renderText: this.readRenderText(host),
        elapsedMs: Date.now() - started
      };
    } finally {
      rendezvous.dispose();
      component.unload();
      host.detach();
      if (created) {
        await BaseFileOperations.removeScratchFile(app, scratchPath);
      }
    }
  }

  /**
   * Fail fast on the two states where waiting is pointless.
   *
   * A view type that is gone (Bases toggled off and on again) and a view
   * registered by a Nexus older than the harvest protocol both look exactly
   * like a slow query: the render resolves and no data ever arrives. Neither is
   * recoverable in-process, so both must be named rather than waited out.
   */
  private static assertViewIsUsable(app: App, plugin: Plugin): void {
    const version = refreshAnalyzeViewRegistration(app, plugin);

    if (version === null) {
      throw new BaseAnalyzeError(
        'The Bases core plugin is not available, so a base cannot be executed. Enable Bases in Settings → Core plugins, then reload Nexus.'
      );
    }

    if (version === ANALYZE_PROTOCOL_INERT) {
      throw new BaseAnalyzeError(
        'This Obsidian session is still running an older Nexus analyze view, which never reports results. ' +
        'Obsidian keeps the first registration of a view type for the life of the app, so a plugin reload cannot replace it — restart Obsidian and try again.'
      );
    }
  }

  /** Wait for the first `onDataUpdated`, or explain what silence means. */
  private static async awaitData(view: Promise<BasesView>, timeoutMs: number, host: HTMLElement): Promise<BasesView> {
    let timer: number | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        const text = this.readRenderText(host);
        reject(new BaseAnalyzeError(
          `The base did not produce results within ${timeoutMs} ms.` +
          (text ? ` Obsidian rendered: "${text}".` : ' Obsidian rendered nothing, which usually means the embed did not resolve.')
        ));
      }, timeoutMs);
    });

    try {
      return await Promise.race([view, timeout]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  /**
   * Whatever Obsidian painted into the host.
   *
   * Our view renders nothing, so ANY text here came from Bases itself — an
   * unresolved embed, or a message about a filter it could not evaluate. That
   * matters because a broken filter yields zero rows with no error anywhere in
   * the API: without this, `analyze` would confidently report "no matches" for a
   * base that is simply wrong.
   */
  private static readRenderText(host: HTMLElement): string {
    const text = host.textContent ?? '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  /**
   * The scratch config: the original file with its views replaced by ONE view
   * of our type that clones the requested view.
   *
   * Spreading the source view keeps keys the public type does not name (`limit`,
   * `sort`, view-specific settings) — our headless view ignores what it does not
   * understand, and dropping them would silently change the result. `filters`,
   * `formulas`, `properties` and `summaries` stay at the top level because the
   * view's own filters compose with them.
   */
  private static buildScratchConfig(
    config: BasesConfigFile,
    sourceView: BasesConfigFileView,
    scratchViewName: string
  ): BasesConfigFile {
    return {
      ...config,
      views: [{ ...sourceView, type: NEXUS_ANALYZE_VIEW_ID, name: scratchViewName }]
    };
  }

  private static asRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') out[key] = entry;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Sibling of the source base — see the header for why not the storage root. */
  private static scratchPathFor(sourcePath: string, token: string): string {
    const separator = sourcePath.lastIndexOf('/');
    const folder = separator === -1 ? '' : sourcePath.slice(0, separator + 1);
    return `${folder}${SCRATCH_PREFIX}${token}.base`;
  }

  private static newToken(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Remove scratch files a previous call could not clean up (a crash, a reload
   * mid-render). Age-gated so a concurrent `analyze` is never swept out from
   * under itself, and best-effort: a sweep failure must not fail the query.
   */
  static async sweepStaleScratchFiles(app: App): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - STALE_SCRATCH_MS;

    for (const file of BaseFileOperations.getBaseFiles(app, undefined, true, true)) {
      if (!BaseFileOperations.isScratchPath(file.path)) continue;
      if (file.stat.mtime > cutoff) continue;
      try {
        await BaseFileOperations.removeScratchFile(app, file.path);
        removed++;
      } catch (error) {
        logger.systemWarn(`baseManager - could not sweep scratch file ${file.path}: ${(error as Error).message}`);
      }
    }

    return removed;
  }
}
