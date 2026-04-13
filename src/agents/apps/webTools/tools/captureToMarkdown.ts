import { TFile } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { isDesktop, isElectron } from '../../../../utils/platform';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelWithUrl, verbs } from '../../../utils/toolStatusLabels';
import {
  ensureParentFolderExists,
  findCreatedMarkdownFile,
  getWebViewerLeaf,
  getWebViewerState,
  hasWebViewerSaveCommand,
  openWebViewerUrl,
  resolveUniqueMarkdownPath,
  waitForWebViewerReady,
  WEB_VIEWER_SAVE_COMMAND_ID,
  WebViewerOpenMode,
} from '../utils/webViewer';

interface CaptureToMarkdownParams extends CommonParameters {
  url?: string;
  mode?: WebViewerOpenMode;
  outputPath: string;
  timeoutMs?: number;
  settleMs?: number;
}

export class CaptureToMarkdownTool extends BaseTool<CaptureToMarkdownParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'captureToMarkdown',
      'Capture To Markdown',
      'Save the active Web Viewer page to the vault as Markdown using Obsidian Web Viewer. Desktop only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithUrl(verbs('Capturing to markdown', 'Captured to markdown', 'Failed to capture to markdown'), params, tense, 'page');
  }

  async execute(params: CaptureToMarkdownParams): Promise<CommonResult> {
    if (!isDesktop() || !isElectron()) {
      return this.prepareResult(false, undefined, 'Web Viewer tools are desktop-only.');
    }

    const app = this.agent.getApp();
    if (!app) {
      return this.prepareResult(false, undefined, 'Obsidian app is not available.');
    }

    if (!hasWebViewerSaveCommand(app)) {
      return this.prepareResult(
        false,
        undefined,
        'Web Viewer Save to vault command is unavailable. Enable the core Web Viewer plugin in Obsidian.'
      );
    }

    const timeoutMs = params.timeoutMs ?? 20000;
    const settleMs = params.settleMs ?? 1200;

    try {
      const leaf = params.url
        ? await openWebViewerUrl(app, params.url, params.mode ?? 'tab', true)
        : getWebViewerLeaf(app);

      if (!leaf) {
        return this.prepareResult(
          false,
          undefined,
          'No Web Viewer tab is open. Provide a URL or open a page in Web Viewer first.'
        );
      }

      await app.workspace.revealLeaf(leaf);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await waitForWebViewerReady(leaf, timeoutMs, settleMs);

      const beforePaths = new Set(app.vault.getMarkdownFiles().map((file) => file.path));
      const startTimeMs = Date.now();

      await app.commands.executeCommandById(WEB_VIEWER_SAVE_COMMAND_ID);

      let createdFile = await this.waitForCreatedFile(beforePaths, startTimeMs, timeoutMs);
      if (!createdFile) {
        return this.prepareResult(
          false,
          undefined,
          'Web Viewer did not create a Markdown note. The page may not be readable yet or extraction may have failed.'
        );
      }

      let movedFromPath: string | undefined;
      const targetPath = resolveUniqueMarkdownPath(app.vault, params.outputPath);
      if (createdFile.path !== targetPath) {
        await ensureParentFolderExists(app.vault, targetPath);
        movedFromPath = createdFile.path;
        await app.vault.rename(createdFile, targetPath);
        const movedFile = app.vault.getAbstractFileByPath(targetPath);
        if (movedFile instanceof TFile) {
          createdFile = movedFile;
        }
      }

      const state = getWebViewerState(leaf);

      return this.prepareResult(true, {
        path: createdFile.path,
        sourceUrl: state?.url ?? params.url ?? null,
        title: state?.title ?? createdFile.basename,
        usedBuiltInSaveCommand: true,
        movedFromPath,
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
          description: 'Optional URL to open in Web Viewer before capturing. If omitted, captures the active Web Viewer tab.',
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the Web Viewer tab when url is provided.',
          default: 'tab',
        },
        outputPath: {
          type: 'string',
          description: 'Destination note path in the vault. Required so the caller explicitly chooses where the Markdown capture is saved.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for page load and note creation.',
          default: 20000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after page load before invoking Save to vault.',
          default: 1200,
        },
      },
      required: ['outputPath'],
    });
  }

  private async waitForCreatedFile(
    beforePaths: Set<string>,
    startTimeMs: number,
    timeoutMs: number
  ): Promise<TFile | null> {
    const app = this.agent.getApp();
    if (!app) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const file = findCreatedMarkdownFile(app.vault, beforePaths, startTimeMs);
      if (file) {
        return file;
      }

      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }

    return null;
  }
}
