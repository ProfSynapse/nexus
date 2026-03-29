import { AppManifest } from '../../../types/apps/AppTypes';
import { BaseAppAgent } from '../BaseAppAgent';
import { CaptureToMarkdownTool } from './tools/captureToMarkdown';
import { CapturePagePdfTool } from './tools/capturePagePdf';
import { CapturePagePngTool } from './tools/capturePagePng';
import { ExtractLinksTool } from './tools/extractLinks';
import { OpenWebpageTool } from './tools/openWebpage';

const WEB_TOOLS_MANIFEST: AppManifest = {
  id: 'web-tools',
  agentName: 'webTools',
  name: 'Web Tools',
  description: 'Desktop Web Viewer tools for opening webpages and saving them into the vault as Markdown',
  version: '1.0.0',
  author: 'Nexus',
  docsUrl: 'https://help.obsidian.md/plugins/web-viewer',
  credentials: [],
  tools: [
    { slug: 'openWebpage', description: 'Open a webpage in Obsidian Web Viewer' },
    { slug: 'captureToMarkdown', description: 'Save a Web Viewer page into the vault as Markdown' },
    { slug: 'capturePagePng', description: 'Capture a Web Viewer page as a PNG image' },
    { slug: 'capturePagePdf', description: 'Print a Web Viewer page to PDF' },
    { slug: 'extractLinks', description: 'Extract links from a Web Viewer page' },
  ],
};

export class WebToolsAgent extends BaseAppAgent {
  constructor() {
    super(WEB_TOOLS_MANIFEST);

    this.registerTool(new OpenWebpageTool(this));
    this.registerTool(new CaptureToMarkdownTool(this));
    this.registerTool(new CapturePagePngTool(this));
    this.registerTool(new CapturePagePdfTool(this));
    this.registerTool(new ExtractLinksTool(this));
  }
}
