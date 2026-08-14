import { App, requestUrl, TFile } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { isDesktop, isElectron } from '../../../../utils/platform';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelWithUrl, verbs } from '../../../utils/toolStatusLabels';
import {
  assertSafeWebUrl,
  ensureParentFolderExists,
  getWebViewerContents,
  getWebViewerLeaf,
  getWebViewerState,
  openWebViewerUrl,
  resolveUniqueMarkdownPath,
  waitForWebViewerReady,
  WebViewerOpenMode,
} from '../utils/webViewer';
import { ExtractedWebPage, WebContentExtractor } from '../services/WebContentExtractor';
import {
  buildCaptureNote,
  isExtractableResponse,
  looksLikeEmptyShell,
  readContentType,
  WebCaptureTransport,
} from '../services/webCaptureNote';
import { LIVE_DOM_CAPTURE_SCRIPT, toLiveDomSnapshot } from '../services/liveDomCapture';

type TransportChoice = 'auto' | WebCaptureTransport;

interface CaptureToMarkdownParams extends CommonParameters {
  url?: string;
  transport?: TransportChoice;
  mode?: WebViewerOpenMode;
  outputPath: string;
  minWordCount?: number;
  timeoutMs?: number;
  settleMs?: number;
}

interface TransportOutcome {
  page: ExtractedWebPage;
  transport: WebCaptureTransport;
  sourceUrl: string | null;
}

const DEFAULT_MIN_WORD_COUNT = 100;

export class CaptureToMarkdownTool extends BaseTool<CaptureToMarkdownParams, CommonResult> {
  private agent: BaseAppAgent;
  private extractor: WebContentExtractor;

  /**
   * `extractor` is injectable so transport selection can be tested without a
   * DOM — Defuddle needs a real one, the selection logic does not.
   */
  constructor(agent: BaseAppAgent, extractor: WebContentExtractor = new WebContentExtractor()) {
    super(
      'capture-markdown',
      'Capture To Markdown',
      'Extract a webpage as Markdown with metadata frontmatter and save it to the vault. Fetches the URL directly (works on mobile); falls back to the desktop Web Viewer for pages that need JavaScript or a signed-in session.',
      '2.0.0'
    );
    this.agent = agent;
    this.extractor = extractor;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithUrl(verbs('Capturing to markdown', 'Captured to markdown', 'Failed to capture to markdown'), params, tense, 'page');
  }

  async execute(params: CaptureToMarkdownParams): Promise<CommonResult> {
    const app = this.agent.getApp();
    if (!app) {
      return this.prepareResult(false, undefined, 'Obsidian app is not available.');
    }

    const transport = params.transport ?? 'auto';
    if (transport === 'browser' && !browserTransportAvailable()) {
      return this.prepareResult(false, undefined, 'The browser transport needs the desktop Web Viewer. Use transport "fetch" on mobile.');
    }

    if (transport === 'fetch' && !params.url) {
      return this.prepareResult(false, undefined, 'A url is required for the fetch transport.');
    }

    if (!params.url && !browserTransportAvailable()) {
      return this.prepareResult(false, undefined, 'A url is required. Capturing the open Web Viewer tab is desktop-only.');
    }

    try {
      const outcome = await this.capture(app, params, transport);
      if (!outcome) {
        return this.prepareResult(false, undefined, 'Could not retrieve the page. It may be unreachable, or may not be HTML.');
      }

      if (!outcome.page.markdown) {
        return this.prepareResult(
          false,
          undefined,
          `Extracted no readable content from the page via the ${outcome.transport} transport.`
        );
      }

      const path = await this.writeNote(app, params.outputPath, outcome);

      return this.prepareResult(true, {
        path,
        sourceUrl: outcome.sourceUrl,
        transport: outcome.transport,
        title: outcome.page.metadata.title,
        author: outcome.page.metadata.author,
        published: outcome.page.metadata.published,
        site: outcome.page.metadata.site,
        wordCount: outcome.page.metadata.wordCount,
        extractorType: outcome.page.extractorType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, `Failed to capture webpage: ${message}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Page to capture. Required unless transport is "browser", which can capture the already-open Web Viewer tab.',
        },
        outputPath: {
          type: 'string',
          description: 'Destination note path in the vault. Required so the caller explicitly chooses where the Markdown capture is saved.',
        },
        transport: {
          type: 'string',
          enum: ['auto', 'fetch', 'browser'],
          description: 'How to retrieve the page. "fetch" downloads it directly and is the only option on mobile. "browser" renders it in the desktop Web Viewer, which handles JavaScript-rendered and signed-in pages. "auto" fetches first and falls back to the browser on desktop.',
          default: 'auto',
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the Web Viewer tab when the browser transport is used.',
          default: 'tab',
        },
        minWordCount: {
          type: 'number',
          description: 'Under "auto", a fetch result with fewer words than this is treated as a JavaScript-rendered shell and retried in the browser.',
          default: DEFAULT_MIN_WORD_COUNT,
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for the Web Viewer page to load (browser transport only).',
          default: 20000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after page load before reading the DOM (browser transport only).',
          default: 1200,
        },
      },
      required: ['outputPath'],
    });
  }

  /**
   * Run the requested transport, or under `auto` try the cheap one first.
   *
   * Returns null when no transport produced a page at all; an empty extraction
   * is reported by the caller, which can name the transport that came up short.
   */
  private async capture(
    app: App,
    params: CaptureToMarkdownParams,
    transport: TransportChoice
  ): Promise<TransportOutcome | null> {
    if (transport === 'browser') {
      return this.captureViaBrowser(app, params);
    }

    const fetched = params.url ? await this.captureViaFetch(params.url) : null;

    if (transport === 'fetch') {
      return fetched;
    }

    // auto: keep the fetch result unless it is missing or looks like an SPA shell.
    const minWordCount = params.minWordCount ?? DEFAULT_MIN_WORD_COUNT;
    const fetchSufficed = fetched !== null
      && fetched.page.markdown.length > 0
      && !looksLikeEmptyShell(fetched.page.metadata.wordCount, minWordCount);

    if (fetchSufficed || !browserTransportAvailable()) {
      return fetched;
    }

    try {
      return await this.captureViaBrowser(app, params);
    } catch (error) {
      // The fallback is best-effort: a fetch result that merely looked thin is
      // better than surfacing a Web Viewer timeout the caller did not ask for.
      if (fetched) {
        return fetched;
      }
      throw error;
    }
  }

  private async captureViaFetch(url: string): Promise<TransportOutcome | null> {
    assertSafeWebUrl(url);

    const response = await requestUrl({ url, method: 'GET', throw: false });
    if (!isExtractableResponse(response.status, readContentType(response.headers))) {
      return null;
    }

    const page = await this.extractor.extractFromHtml(response.text, url);
    return { page, transport: 'fetch', sourceUrl: url };
  }

  private async captureViaBrowser(app: App, params: CaptureToMarkdownParams): Promise<TransportOutcome | null> {
    const timeoutMs = params.timeoutMs ?? 20000;
    const settleMs = params.settleMs ?? 1200;

    const leaf = params.url
      ? await openWebViewerUrl(app, params.url, params.mode ?? 'tab', true)
      : getWebViewerLeaf(app);

    if (!leaf) {
      throw new Error('No Web Viewer tab is open. Provide a URL or open a page in Web Viewer first.');
    }

    await app.workspace.revealLeaf(leaf);
    app.workspace.setActiveLeaf(leaf, { focus: true });

    const contents = await waitForWebViewerReady(leaf, timeoutMs, settleMs)
      ?? getWebViewerContents(leaf);
    if (!contents?.executeJavaScript) {
      throw new Error('Web Viewer executeJavaScript() is unavailable in this Obsidian build.');
    }

    const snapshot = toLiveDomSnapshot(await contents.executeJavaScript<unknown>(LIVE_DOM_CAPTURE_SCRIPT));
    if (!snapshot) {
      return null;
    }

    const sourceUrl = snapshot.url || getWebViewerState(leaf)?.url || params.url || null;
    const page = await this.extractor.extractFromHtml(snapshot.html, sourceUrl ?? undefined);

    // The live DOM knows the page title even when extraction does not.
    if (!page.metadata.title && snapshot.title) {
      page.metadata.title = snapshot.title;
    }

    return { page, transport: 'browser', sourceUrl };
  }

  private async writeNote(app: App, outputPath: string, outcome: TransportOutcome): Promise<string> {
    // resolveUniqueMarkdownPath confines the caller-supplied path to the vault
    // and throws VaultPathError on traversal, which execute() surfaces.
    const targetPath = resolveUniqueMarkdownPath(app.vault, outputPath);
    await ensureParentFolderExists(app.vault, targetPath);

    const contents = buildCaptureNote(
      outcome.page.markdown,
      outcome.page.metadata,
      outcome.sourceUrl,
      new Date().toISOString()
    );

    const file = await app.vault.create(targetPath, contents);
    return file instanceof TFile ? file.path : targetPath;
  }
}

/**
 * The Web Viewer is an Electron `<webview>`, so the browser transport exists
 * only on desktop. The fetch transport has no such constraint — it is the first
 * webTools capability that runs on mobile.
 */
function browserTransportAvailable(): boolean {
  return isDesktop() && isElectron();
}
