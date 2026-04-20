import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ReadCanvasTool,
  WriteCanvasTool,
  UpdateCanvasTool,
  ListCanvasTool
} from './tools';
import NexusPlugin from '../../main';

/**
 * Agent for canvas operations in the vault
 *
 * Tools (4 total):
 * - read: Read canvas structure (nodes and edges)
 * - write: Create a NEW canvas file
 * - update: Modify an EXISTING canvas file
 * - list: List canvas files in the vault
 *
 * Workflow: LLM reads → modifies in context → writes/updates back
 */
export class CanvasManagerAgent extends BaseAgent {
  protected app: App;
  protected plugin: NexusPlugin | null = null;

  constructor(app: App, plugin?: NexusPlugin) {
    super(
      'canvasManager',
      'Canvas operations for Obsidian infinite canvas files. Read, create, and modify canvas files with nodes (text, file, link, group) and edges.',
      '1.0.0'
    );

    this.app = app;
    this.plugin = plugin || null;

    // Register 4 tools - lazy loaded
    this.registerLazyTool({
      slug: 'read', name: 'Read Canvas',
      description: 'Read the structure of a canvas file (nodes and edges)',
      version: '1.0.0',
      factory: () => new ReadCanvasTool(app),
    });
    this.registerLazyTool({
      slug: 'write', name: 'Write Canvas',
      description: 'Create a NEW canvas file. Fails if canvas already exists - use canvasManager.update to modify existing canvases.',
      version: '1.0.0',
      factory: () => new WriteCanvasTool(app),
    });
    this.registerLazyTool({
      slug: 'update', name: 'Update Canvas',
      description: 'Modify an EXISTING canvas file. Replaces nodes and/or edges arrays. Fails if canvas does not exist - use canvasManager.write to create new canvases.',
      version: '1.0.0',
      factory: () => new UpdateCanvasTool(app),
    });
    this.registerLazyTool({
      slug: 'list', name: 'List Canvases',
      description: 'List canvas files in the vault with node/edge counts',
      version: '1.0.0',
      factory: () => new ListCanvasTool(app),
    });
  }
}
