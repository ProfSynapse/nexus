import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ReadTool,
  WriteTool,
  ReplaceTool,
  InsertTool,
  SetPropertyTool
} from './tools';
import NexusPlugin from '../../main';
import { WorkspaceService } from '../../services/WorkspaceService';
import { MemoryService } from '../memoryManager/services/MemoryService';

/**
 * Agent for content operations in the vault
 *
 * Tools:
 * - read: Read content from files with explicit line ranges
 * - write: Create new files or overwrite existing files
 * - replace: Replace or delete existing content with validation
 * - insert: Insert new content at a specific position
 * - setProperty: Set frontmatter properties with optional merge mode
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

    // Register tools (5 tools) - lazy loaded
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
      slug: 'replace', name: 'Replace',
      description: 'Replace or delete existing content in a note. Validates that the content at the specified lines matches before making changes. If the content has moved, returns the new line numbers.',
      version: '1.0.0',
      factory: () => new ReplaceTool(app),
    });
    this.registerLazyTool({
      slug: 'insert', name: 'Insert',
      description: 'Insert new content into a note at a specific position. Does not modify existing content — use replace for that.',
      version: '1.0.0',
      factory: () => new InsertTool(app),
    });
    this.registerLazyTool({
      slug: 'setProperty', name: 'Set property',
      description: 'Set a frontmatter property on a note. Supports "replace" (default) and "merge" (array union with dedup) modes.',
      version: '1.0.0',
      factory: () => new SetPropertyTool(app),
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
