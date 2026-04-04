import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { isDesktop, isElectron } from '../../../../utils/platform';
import {
  getWebViewerContents,
  getWebViewerLeaf,
  getWebViewerState,
  openWebViewerUrl,
  waitForWebViewerReady,
  WebViewerOpenMode,
} from '../utils/webViewer';

interface ExtractLinksParams extends CommonParameters {
  url?: string;
  mode?: WebViewerOpenMode;
  maxLinks?: number;
  timeoutMs?: number;
  settleMs?: number;
}

interface ExtractedLink {
  href: string;
  text: string;
}

export class ExtractLinksTool extends BaseTool<ExtractLinksParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'extractLinks',
      'Extract Links',
      'Extract links from the current Web Viewer page. Desktop only.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ExtractLinksParams): Promise<CommonResult> {
    if (!isDesktop() || !isElectron()) {
      return this.prepareResult(false, undefined, 'Web Viewer tools are desktop-only.');
    }

    const app = this.agent.getApp();
    if (!app) {
      return this.prepareResult(false, undefined, 'Obsidian app is not available.');
    }

    const timeoutMs = params.timeoutMs ?? 20000;
    const settleMs = params.settleMs ?? 1200;
    const maxLinks = params.maxLinks ?? 200;

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
      if (!contents?.executeJavaScript) {
        return this.prepareResult(false, undefined, 'Web Viewer executeJavaScript() is unavailable in this Obsidian build.');
      }

      const links = await contents.executeJavaScript<ExtractedLink[]>(
        `(function() {
          const seen = new Set();
          return Array.from(document.links)
            .map((link) => ({
              href: link.href || '',
              text: (link.innerText || link.textContent || '').trim()
            }))
            .filter((link) => {
              if (!link.href || seen.has(link.href)) return false;
              seen.add(link.href);
              return true;
            })
            .slice(0, ${Math.max(1, maxLinks)});
        })()`
      );

      const state = getWebViewerState(leaf);

      return this.prepareResult(true, {
        sourceUrl: state?.url ?? params.url ?? null,
        title: state?.title ?? null,
        count: links.length,
        links,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, `Failed to extract links: ${message}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional URL to open in Web Viewer before extracting links.',
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the Web Viewer tab when url is provided.',
          default: 'tab',
        },
        maxLinks: {
          type: 'number',
          description: 'Maximum number of links to return.',
          default: 200,
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait for page load.',
          default: 20000,
        },
        settleMs: {
          type: 'number',
          description: 'Extra delay after page load before extracting links.',
          default: 1200,
        },
      },
    });
  }
}
