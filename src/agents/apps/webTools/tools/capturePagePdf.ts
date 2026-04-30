import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { isDesktop, isElectron } from '../../../../utils/platform';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelWithUrl, verbs } from '../../../utils/toolStatusLabels';
import {
  ensureParentFolderExists,
  getWebViewerContents,
  getWebViewerLeaf,
  getWebViewerState,
  openWebViewerUrl,
  resolveUniqueFilePath,
  toArrayBuffer,
  waitForWebViewerReady,
  WebViewerOpenMode,
} from '../utils/webViewer';

interface CapturePagePdfParams extends CommonParameters {
  url?: string;
  mode?: WebViewerOpenMode;
  outputPath: string;
  timeoutMs?: number;
  settleMs?: number;
}

export class CapturePagePdfTool extends BaseTool<CapturePagePdfParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'capture-pdf',
      'Capture Page PDF',
      'Print the current Web Viewer page to PDF and save it to the vault. Desktop only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithUrl(verbs('Capturing PDF', 'Captured PDF', 'Failed to capture PDF'), params, tense, 'page');
  }

  async execute(params: CapturePagePdfParams): Promise<CommonResult> {
    if (!isDesktop() || !isElectron()) {
      return this.prepareResult(false, undefined, 'Web Viewer tools are desktop-only.');
    }

    const app = this.agent.getApp();
    if (!app) {
      return this.prepareResult(false, undefined, 'Obsidian app is not available.');
    }

    const timeoutMs = params.timeoutMs ?? 20000;
    const settleMs = params.settleMs ?? 1200;

    try {
      const leaf = params.url
        ? await openWebViewerUrl(app, params.url, params.mode ?? 'tab', true)
        : getWebViewerLeaf(app);

      if (!leaf) {
        return this.prepareResult(false, undefined, 'No Web Viewer tab is open. Provide a URL or open a page in Web Viewer first.');
      }

      await app.workspace.revealLeaf(leaf);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const contents = await waitForWebViewerReady(leaf, timeoutMs, settleMs)
        ?? getWebViewerContents(leaf);
      if (!contents?.printToPDF) {
        return this.prepareResult(false, undefined, 'Web Viewer printToPDF() is unavailable in this Obsidian build.');
      }

      const pdfData = toArrayBuffer(await contents.printToPDF({
        printBackground: true,
        landscape: false,
        pageSize: 'Letter',
        margins: {
          top: 0.4,
          bottom: 0.4,
          left: 0.4,
          right: 0.4,
        },
      }));
      const state = getWebViewerState(leaf);
      const outputPath = resolveUniqueFilePath(app.vault, params.outputPath, 'pdf');

      await ensureParentFolderExists(app.vault, outputPath);
      await app.vault.createBinary(outputPath, pdfData);

      return this.prepareResult(true, {
        path: outputPath,
        sourceUrl: state?.url ?? params.url ?? null,
        title: state?.title ?? 'web-capture',
        format: 'pdf',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, `Failed to capture PDF: ${message}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional URL to open in Web Viewer before capturing.',
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the Web Viewer tab when url is provided.',
          default: 'tab',
        },
        outputPath: {
          type: 'string',
          description: 'Destination PDF path in the vault. Required so the caller explicitly chooses where the document is saved.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for page load.',
          default: 20000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after page load before printing.',
          default: 1200,
        },
      },
      required: ['outputPath'],
    });
  }
}
