import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ReadTool,
  WriteTool,
  UpdateTool
} from './tools';
import NexusPlugin from '../../main';
import { WorkspaceService } from '../../services/WorkspaceService';
import { MemoryService } from '../memoryManager/services/MemoryService';

/**
 * Agent for content operations in the vault
 * Simplified from 8 tools to 3 tools following CRUA pattern
 *
 * Tools:
 * - read: Read content from files with explicit line ranges
 * - write: Create new files or overwrite existing files
 * - update: Insert, replace, delete, append, or prepend content
 */
export class ContentManagerAgent extends BaseAgent {
  protected app: App;
  protected plugin: NexusPlugin | null = null;

  private workspaceService: WorkspaceService | null = null;
  private memoryService: MemoryService | null = null;

  /**
   * Create a new ContentManagerAgent
   * @param app Obsidian app instance
   * @param plugin Nexus plugin instance
   * @param memoryService Optional injected memory service
   * @param workspaceService Optional injected workspace service
   */
  constructor(
    app: App,
    plugin?: NexusPlugin,
    memoryService?: MemoryService | null,
    workspaceService?: WorkspaceService | null
  ) {
    super(
      'contentManager',
      'Content operations for Obsidian notes',
      '1.0.0'
    );

    this.app = app;
    this.plugin = plugin || null;

    // Use injected services if provided, otherwise fall back to plugin services
    if (memoryService) {
      this.memoryService = memoryService;
    } else if (plugin?.services?.memoryService) {
      this.memoryService = plugin.services.memoryService;
    }

    if (workspaceService) {
      this.workspaceService = workspaceService;
    } else if (plugin?.services?.workspaceService) {
      this.workspaceService = plugin.services.workspaceService;
    }

    // Register simplified tools (3 tools replacing 8) - lazy loaded
    this.registerLazyTool({
      slug: 'read', name: 'Read',
      description: 'Read content from a file with line range',
      version: '1.0.0',
      factory: () => new ReadTool(app),
    });
    this.registerLazyTool({
      slug: 'write', name: 'Write',
      description: 'Create a new file or overwrite existing file',
      version: '1.0.0',
      factory: () => new WriteTool(app),
    });
    this.registerLazyTool({
      slug: 'update', name: 'Update',
      description: 'Update file content. Two modes: (1) Line-based: provide startLine, endLine, content to insert/replace/delete at specific lines. (2) Find-replace: provide find, replace to substitute text by content match. Returns linesDelta showing net line change.',
      version: '1.0.0',
      factory: () => new UpdateTool(app),
    });
  }
  
  
  /**
   * Gets the workspace service
   * @returns WorkspaceService instance or null
   */
  public getWorkspaceService(): WorkspaceService | null {
    return this.workspaceService;
  }
  
  /**
   * Gets the memory service
   * @returns MemoryService instance or null
   */
  public getMemoryService(): MemoryService | null {
    return this.memoryService;
  }
  
}
