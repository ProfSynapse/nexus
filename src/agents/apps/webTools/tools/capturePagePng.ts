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

interface CapturePagePngParams extends CommonParameters {
  url?: string;
  mode?: WebViewerOpenMode;
  outputPath: string;
  timeoutMs?: number;
  settleMs?: number;
}

export class CapturePagePngTool extends BaseTool<CapturePagePngParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'capturePagePng',
      'Capture Page PNG',
      'Capture the current Web Viewer page as a PNG image and save it to the vault. Desktop only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithUrl(verbs('Capturing PNG', 'Captured PNG', 'Failed to capture PNG'), params, tense, 'page');
  }

  async execute(params: CapturePagePngParams): Promise<CommonResult> {
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
      if (!contents?.capturePage) {
        return this.prepareResult(false, undefined, 'Web Viewer capturePage() is unavailable in this Obsidian build.');
      }

      const image = await contents.capturePage();
      const pngData = toArrayBuffer(image.toPNG());
      const state = getWebViewerState(leaf);
      const outputPath = resolveUniqueFilePath(app.vault, params.outputPath, 'png');

      await ensureParentFolderExists(app.vault, outputPath);
      await app.vault.createBinary(outputPath, pngData);

      return this.prepareResult(true, {
        path: outputPath,
        sourceUrl: state?.url ?? params.url ?? null,
        title: state?.title ?? 'web-capture',
        format: 'png',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, `Failed to capture PNG: ${message}`);
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
          description: 'Destination PNG path in the vault. Required so the caller explicitly chooses where the image is saved.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for page load.',
          default: 20000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after page load before capturing.',
          default: 1200,
        },
      },
      required: ['outputPath'],
    });
  }
}
