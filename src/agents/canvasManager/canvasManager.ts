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

    // Register 4 tools
    this.registerTool(new ReadCanvasTool(app));
    this.registerTool(new WriteCanvasTool(app));
    this.registerTool(new UpdateCanvasTool(app));
    this.registerTool(new ListCanvasTool(app));
  }
}
