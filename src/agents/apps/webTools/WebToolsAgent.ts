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
  description: 'Capture webpages into the vault as Markdown, plus desktop Web Viewer tools for opening, screenshotting and reading links from a page',
  version: '1.0.0',
  author: 'Nexus',
  credentials: [],
  validation: {
    mode: 'none',
  },
  tools: [
    { slug: 'open', description: 'Open a webpage in Obsidian Web Viewer' },
    { slug: 'capture-markdown', description: 'Extract a webpage into the vault as Markdown with metadata frontmatter (works on mobile)' },
    { slug: 'capture-png', description: 'Capture a Web Viewer page as a PNG image' },
    { slug: 'capture-pdf', description: 'Print a Web Viewer page to PDF' },
    { slug: 'links', description: 'Extract links from a Web Viewer page' },
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
