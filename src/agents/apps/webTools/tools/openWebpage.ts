import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import {
  getWebViewerState,
  openWebViewerUrl,
  waitForWebViewerReady,
  WebViewerOpenMode,
} from '../utils/webViewer';
import { isDesktop, isElectron } from '../../../../utils/platform';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelWithUrl, verbs } from '../../../utils/toolStatusLabels';

interface OpenWebpageParams extends CommonParameters {
  url: string;
  mode?: WebViewerOpenMode;
  focus?: boolean;
  timeoutMs?: number;
  settleMs?: number;
}

export class OpenWebpageTool extends BaseTool<OpenWebpageParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'openWebpage',
      'Open Webpage',
      'Open a webpage in Obsidian Web Viewer. Desktop only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithUrl(verbs('Opening', 'Opened', 'Failed to open'), params, tense);
  }

  async execute(params: OpenWebpageParams): Promise<CommonResult> {
    if (!isDesktop() || !isElectron()) {
      return this.prepareResult(false, undefined, 'Web Viewer tools are desktop-only.');
    }

    const app = this.agent.getApp();
    if (!app) {
      return this.prepareResult(false, undefined, 'Obsidian app is not available.');
    }

    const mode = params.mode ?? 'tab';
    const focus = params.focus !== false;
    const timeoutMs = params.timeoutMs ?? 15000;
    const settleMs = params.settleMs ?? 800;

    try {
      const leaf = await openWebViewerUrl(app, params.url, mode, focus);
      await waitForWebViewerReady(leaf, timeoutMs, settleMs);
      const state = getWebViewerState(leaf);

      return this.prepareResult(true, {
        url: state?.url ?? params.url,
        title: state?.title ?? params.url,
        mode,
        focused: focus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, `Failed to open webpage: ${message}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The webpage URL to open in Obsidian Web Viewer.',
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the Web Viewer tab.',
          default: 'tab',
        },
        focus: {
          type: 'boolean',
          description: 'Whether to focus the Web Viewer tab after opening it.',
          default: true,
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for the page to load.',
          default: 15000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after load before returning, to allow client-side rendering to settle.',
          default: 800,
        },
      },
      required: ['url'],
    });
  }
}
